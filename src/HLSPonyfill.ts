import type Hls from 'hls.js';
import { MediaPlaylist, NonNativeTextTrack, HlsListeners } from 'hls.js';
import {
    AudioTrackList,
    AudioTrack,
    VideoTrackList,
    VideoTrack,
    clearTrackList,
} from 'media-track-list';
import { clamp } from './clamp';
import { getStartDate } from './getStartDate';
import { getUrlProtocol } from './getUrlProtocol';
import { isHlsSource } from './isHlsSource';
import { SeekableTimeRanges } from './SeekableTimeRanges';
import { addCueToTrack } from './addCueToTrack';

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
const FAKE_VTT = URL.createObjectURL(
    new Blob(['WEBVTT'], { type: 'text/vtt' }),
);

/**
 * A wrapper that ties hls.js to a given HTMLVideoElement without touching its prototype.
 * It also manages an AudioTrackList / VideoTrackList in a "media-track-list" style.
 * If these lists already exist (e.g., from your Dash-based code), it reuses them,
 * otherwise it creates them.
 */
export class HLSPonyfill {
    /**
     * Optional global or user-supplied Hls constructor from 'hls.js'.
     * To set it, do:
     *   HLSPonyfill.Hls = YourImportedHls
     */
    private static HlsConstructor?: typeof Hls;

    /**
     * @returns the currently assigned hls.js constructor
     * throws an error if none is found
     */
    public static get Hls(): typeof Hls {
        const HlsCtor = HLSPonyfill.HlsConstructor || (globalThis as any).Hls;
        if (!HlsCtor) {
            throw new Error(
                'HLSPonyfill: no Hls constructor found. Assign one via HLSPonyfill.Hls = require("hls.js") (or import).',
            );
        }
        return HlsCtor;
    }

    /**
     * Sets the hls.js constructor to be used by HLSPonyfill
     */
    public static set Hls(HlsConstructor: typeof Hls) {
        HLSPonyfill.HlsConstructor = HlsConstructor;
    }

    private video: HTMLVideoElement;

    /**
     * The current hls.js instance, if we've set an HLS src
     */
    private hlsInstance?: Hls;

    /**
     * If the current src is an HLS URL, we store it here
     */
    private hlsSrc?: string;

    /**
     * For manual handling of the live/event "seekable" range
     */
    private seekableTimeRanges?: SeekableTimeRanges;
    public getSeekableRanges(): SeekableTimeRanges | undefined {
        return this.seekableTimeRanges;
    }
    /**
     * References to video and audio track lists
     * If the video element does not have them, we create them
     */
    private videoTrackList?: VideoTrackList;
    private audioTrackList?: AudioTrackList;

    /**
     * We store tracks we ourselves created (HLS levels/tracks)
     * to remove them without affecting any other (e.g. Dash) tracks.
     */
    private createdVideoTracks = new Set<VideoTrack>();
    private createdAudioTracks = new Set<AudioTrack>();

    /**
     * For removing "change" event listeners on track lists (only if we attach them)
     */
    private onVideoTracksChangeBound?: VoidFunction;
    private onAudioTracksChangeBound?: VoidFunction;

    /**
     * Creates a new HLSPonyfill wrapper for a given <video> element
     */
    constructor(video: HTMLVideoElement) {
        this.video = video;
    }

    /**
     * Returns 'probably' for hls mime-type
     */
    public static isSupported(
        mime: string,
    ): ReturnType<HTMLVideoElement['canPlayType']> {
        if (mime === HLS_MIME_TYPE) {
            return 'probably';
        }

        return '';
    }

    /**
     * Sets the source URL for the video. If it's HLS, we initialize hls.js;
     * otherwise we just set video.src directly.
     */
    public setSrc(src: string): void {
        if (!src) {
            this.detachHls();
            this.video.removeAttribute('src');
            return;
        }

        if (isHlsSource(src)) {
            this.initHls(src);
        } else {
            const isBlobUrl = getUrlProtocol(src) === 'blob:';
            const isAttached = !!this.hlsInstance?.media;
            // If switching away from HLS to a normal src, detach
            if (isAttached && !isBlobUrl) {
                this.detachHls();
            }
            this.hlsSrc = undefined;
            this.video.src = src;
        }
    }

    /**
     * @returns the current video src (either from <video> or the HLS m3u8)
     */
    public getSrc(): string {
        return this.hlsSrc === undefined ? this.video.src : this.hlsSrc;
    }

    /**
     * Typical convenience accessor for currentTime
     * (including optional clamp for Live/Event streams)
     */
    public get currentTime(): number {
        return this.video.currentTime;
    }

    public set currentTime(value: number) {
        if (this.hlsSrc !== undefined && this.video.seekable.length > 0) {
            value = clamp(
                value,
                this.video.seekable.start(0),
                this.video.seekable.end(0),
            );
        }
        this.video.currentTime = value;
    }

    /**
     * If we want a "getStartDate()" analog like in Safari:
     */
    public getStartDate(): Date {
        if (!this.hlsSrc) {
            // if "webkitGetStartDate" is available natively:
            if (typeof (this.video as any).getStartDate === 'function') {
                return (this.video as any).getStartDate();
            }
            return new Date(NaN);
        }
        return getStartDate(this.hls); // from the hls.js instance
    }

    /**
     * Removes hls.js from this video, clearing any HLS tracks we created
     */
    public detach(): void {
        this.detachHls();
    }

    /**
     * @returns the underlying hls.js instance, if currently active
     */
    public get hls(): Hls | undefined {
        return this.hlsInstance && this.hlsInstance.media === this.video
            ? this.hlsInstance
            : undefined;
    }

    /**
     * Initializes hls.js for a given m3u8 URL
     */
    private initHls(src: string): void {
        this.detachHls(); // detach old instance if any

        // Ensure we have a VideoTrackList / AudioTrackList to manage
        this.initVideoTrackList();
        this.initAudioTrackList();

        const HlsCtor = HLSPonyfill.Hls;
        const hls = new HlsCtor({
            liveDurationInfinity: true,
            renderTextTracksNatively: false,
        });

        // If we want to handle custom "live" seekable range logic:
        this.seekableTimeRanges = new SeekableTimeRanges(
            () => this.hlsInstance,
            this.video.seekable,
        );

        this.hlsInstance = hls;
        this.hlsSrc = src;

        // Helper to attach a listener so that when MEDIA_DETACHING occurs,
        // we remove the same listener to avoid memory leaks
        const on = <E extends keyof HlsListeners>(
            event: E,
            listener: HlsListeners[E],
        ): void => {
            hls.on(event, listener);
            hls.on(HlsCtor.Events.MEDIA_DETACHING, () =>
                hls.off(event, listener),
            );
        };

        // For track-lists
        on(HlsCtor.Events.MANIFEST_LOADED, () => this.updateTrackLists(hls));
        on(HlsCtor.Events.LEVEL_SWITCHED, () => this.updateVideoTrack(hls));
        on(HlsCtor.Events.AUDIO_TRACK_SWITCHED, () =>
            this.updateAudioTrack(hls),
        );

        // For text tracks
        on(HlsCtor.Events.SUBTITLE_TRACK_SWITCH, () =>
            this.updateTextTrack(hls),
        );
        on(HlsCtor.Events.NON_NATIVE_TEXT_TRACKS_FOUND, (e, { tracks }) =>
            this.initNativeTextTrack(tracks),
        );
        on(HlsCtor.Events.CUES_PARSED, (e, { cues }) =>
            this.addCues(cues, hls),
        );

        // Watch for user changes in <video>.textTracks => switch subtitle in hls
        const onTextTracksChange = () => {
            for (let i = 0; i < this.video.textTracks.length; i++) {
                const t = this.video.textTracks[i];
                if (t.mode !== 'disabled') {
                    const idx = hls.subtitleTracks.findIndex((hlsTrack) =>
                        isCorrespondingTrack(t, hlsTrack),
                    );
                    if (idx >= 0 && hls.subtitleTrack !== idx) {
                        hls.subtitleTrack = idx;
                    }
                }
            }
        };
        this.video.textTracks.addEventListener('change', onTextTracksChange);
        hls.on(HlsCtor.Events.MEDIA_DETACHING, () =>
            this.video.textTracks.removeEventListener(
                'change',
                onTextTracksChange,
            ),
        );

        // Finally attach hls.js to the video element
        hls.loadSource(src);
        hls.attachMedia(this.video);
    }

    /**
     * Destroys current hls.js instance, removing added text/webvtt tracks
     * and clearing out video/audio track-lists from this HLS context
     */
    private detachHls(): void {
        // Remove all text <track> elements that we ourselves appended
        const textTracks = this.video.querySelectorAll(
            'track[data-hls-ponyfill]',
        );
        textTracks.forEach((trackNode) => {
            trackNode.remove();
        });

        // Clear out the HLS-specific tracks from videoTrackList / audioTrackList
        if (this.videoTrackList) {
            if (this.onVideoTracksChangeBound) {
                this.videoTrackList.removeEventListener(
                    'change',
                    this.onVideoTracksChangeBound,
                );
            }
            // remove only those tracks we created
            this.createdVideoTracks.forEach((track) =>
                this.videoTrackList?.removeTrack(track),
            );
            this.createdVideoTracks.clear();
        }

        if (this.audioTrackList) {
            if (this.onAudioTracksChangeBound) {
                this.audioTrackList.removeEventListener(
                    'change',
                    this.onAudioTracksChangeBound,
                );
            }
            // remove only those tracks we created
            this.createdAudioTracks.forEach((track) =>
                this.audioTrackList?.removeTrack(track),
            );
            this.createdAudioTracks.clear();
        }

        // If a hls.js instance exists, detach/destroy it
        if (this.hlsInstance) {
            this.hlsInstance.detachMedia();
            this.hlsInstance.destroy();
            this.hlsInstance = undefined;
        }
        this.hlsSrc = undefined;
        this.seekableTimeRanges = undefined;
    }

    //--------------------------------------------------------------------------
    //
    // Track-list creation or reuse
    //
    //--------------------------------------------------------------------------
    private initVideoTrackList(): void {
        const possibleList = (this.video as any).videoTracks;

        if (!possibleList || !(possibleList instanceof VideoTrackList)) {
            // If there's no existing track list, create our own:
            this.videoTrackList = new VideoTrackList();
            // Optionally store it on the video so the outside world can see:
            (this.video as any).videoTracks = this.videoTrackList;
        } else {
            // Reuse an existing list (e.g. from Dash)
            this.videoTrackList = possibleList;
        }

        // Subscribe to "change" only once:
        this.onVideoTracksChangeBound = this.onVideoTracksChange.bind(this);
        this.videoTrackList.addEventListener(
            'change',
            this.onVideoTracksChangeBound,
        );
    }

    private initAudioTrackList(): void {
        const possibleList = (this.video as any).audioTracks;
        if (!possibleList || !(possibleList instanceof AudioTrackList)) {
            this.audioTrackList = new AudioTrackList();
            (this.video as any).audioTracks = this.audioTrackList;
        } else {
            this.audioTrackList = possibleList;
        }

        this.onAudioTracksChangeBound = this.onAudioTracksChange.bind(this);
        this.audioTrackList.addEventListener(
            'change',
            this.onAudioTracksChangeBound,
        );
    }

    /**
     * When the user selects a different VideoTrack from the list, pick the corresponding HLS level
     */
    private onVideoTracksChange(): void {
        if (!this.hls) return;
        const list = this.videoTrackList;
        if (!list) return;

        let selectedTrack: VideoTrack | undefined;
        for (let i = 0; i < list.length; i++) {
            if (list[i].selected) {
                selectedTrack = list[i];
                break;
            }
        }
        if (!selectedTrack) return;

        // If the selected track is already the currently playing level, do nothing
        const currentHlsLevel = this.hls.levels[this.hls.currentLevel];
        if (currentHlsLevel && selectedTrack.id === currentHlsLevel.url[0]) {
            return;
        }

        // Otherwise, set the new level
        const newLevelIndex = this.hls.levels.findIndex(
            ({ url: [id] }) => id === selectedTrack!.id,
        );
        if (newLevelIndex >= 0) {
            this.hls.currentLevel = newLevelIndex;
        }
    }

    /**
     * When the user selects a different AudioTrack from the list, pick the corresponding HLS audioTrack
     */
    private onAudioTracksChange(): void {
        if (!this.hls) return;
        const list = this.audioTrackList;
        if (!list) return;

        let enabledTrack: AudioTrack | undefined;
        for (let i = 0; i < list.length; i++) {
            if (list[i].enabled) {
                enabledTrack = list[i];
                break;
            }
        }
        if (!enabledTrack) return;

        const currentHlsAudio = this.hls.audioTracks[this.hls.audioTrack];
        if (currentHlsAudio && currentHlsAudio.url === enabledTrack.id) {
            return;
        }

        const idx = this.hls.audioTracks.findIndex(
            (t) => t.url === enabledTrack!.id,
        );
        if (idx >= 0) {
            this.hls.audioTrack = idx;
        }
    }

    //--------------------------------------------------------------------------
    //
    // Populate track lists with HLS data
    //
    //--------------------------------------------------------------------------
    private updateTrackLists(hls: Hls): void {
        // If we've detached in the meantime:
        if (!this.hlsSrc) return;
        if (!this.videoTrackList || !this.audioTrackList) return;

        // Clear out only old HLS tracks we previously added
        this.createdVideoTracks.forEach((t) =>
            this.videoTrackList?.removeTrack(t),
        );
        this.createdVideoTracks.clear();

        this.createdAudioTracks.forEach((t) =>
            this.audioTrackList?.removeTrack(t),
        );
        this.createdAudioTracks.clear();

        // Add new levels as VideoTracks
        hls.levels.forEach(
            ({ name, attrs, width, height, bitrate, url: [id] }, idx) => {
                const track = new VideoTrack({
                    id,
                    language: attrs.LANGUAGE,
                    label: name,
                    width,
                    height,
                    bitrate,
                    selected: hls.currentLevel === idx,
                });
                this.videoTrackList!.addTrack(track);
                this.createdVideoTracks.add(track);
            },
        );

        // Add new audio tracks from hls
        hls.audioTracks.forEach(({ lang, name, url }, idx) => {
            const track = new AudioTrack({
                id: url,
                language: lang,
                label: name,
                enabled: hls.audioTrack === idx,
            });
            this.audioTrackList!.addTrack(track);
            this.createdAudioTracks.add(track);
        });
    }

    /**
     * Changes "selected" property on the relevant VideoTrack after HLS switches level
     */
    private updateVideoTrack(hls: Hls): void {
        if (!this.hlsSrc || !this.videoTrackList) return;

        const level = hls.levels[hls.currentLevel];
        if (!level) return;

        const [id] = level.url;
        const videoTrack = this.videoTrackList.getTrackById(id);
        if (videoTrack && !videoTrack.selected) {
            videoTrack.selected = true;
        }
    }

    /**
     * Changes "enabled" property on the relevant AudioTrack after HLS switches audio track
     */
    private updateAudioTrack(hls: Hls): void {
        if (!this.hlsSrc || !this.audioTrackList) return;

        const current = hls.audioTracks[hls.audioTrack];
        if (!current) return;

        const audioTrack = this.audioTrackList.getTrackById(current.url);
        if (audioTrack && !audioTrack.enabled) {
            audioTrack.enabled = true;
        }
    }

    //--------------------------------------------------------------------------
    //
    // Subtitles / text tracks
    //
    //--------------------------------------------------------------------------
    private updateTextTrack(hls: Hls): void {
        const track = hls.subtitleTracks[hls.subtitleTrack];
        if (!track) return;

        // Enable/disable in <video>.textTracks
        for (let i = 0; i < this.video.textTracks.length; i++) {
            const t = this.video.textTracks[i];
            const shouldEnable = isCorrespondingTrack(t, track);
            if (shouldEnable && t.mode === 'disabled') {
                t.mode = 'showing';
            } else if (!shouldEnable && t.mode !== 'disabled') {
                t.mode = 'disabled';
            }
        }
    }

    private initNativeTextTrack(tracks: NonNativeTextTrack[]): void {
        // Creates <track> elements for each found subtitle track
        tracks.forEach((t) => {
            const trackEl = document.createElement('track');
            trackEl.setAttribute('data-hls-ponyfill', 'true');
            trackEl.setAttribute('kind', t.kind);
            trackEl.setAttribute('label', t.label);
            if (t.subtitleTrack?.lang) {
                trackEl.setAttribute('srclang', t.subtitleTrack.lang);
            }
            trackEl.src = FAKE_VTT;
            this.video.appendChild(trackEl);
            trackEl.track.mode = t.default ? 'showing' : 'hidden';
        });
    }

    private addCues(cues: ReadonlyArray<VTTCue>, hls: Hls) {
        if (hls.subtitleTrack === -1) return;
        const currentTrack = hls.subtitleTracks[hls.subtitleTrack];
        if (!currentTrack) return;

        for (let i = 0; i < this.video.textTracks.length; i++) {
            const nativeTrack = this.video.textTracks[i];
            if (isCorrespondingTrack(nativeTrack, currentTrack)) {
                cues.forEach((cue) => addCueToTrack(nativeTrack, cue));
                break;
            }
        }
    }
}

/**
 * Checks if a given TextTrack in the browser corresponds to an Hls.js subtitle track
 */
function isCorrespondingTrack(
    textTrack: TextTrack,
    hlsTrack: MediaPlaylist,
): boolean {
    // Example heuristic: match kind => type, label => name, and language => lang
    return (
        hlsTrack.type.toLowerCase() === textTrack.kind &&
        hlsTrack.name === textTrack.label &&
        (!textTrack.language || textTrack.language === hlsTrack.lang)
    );
}
