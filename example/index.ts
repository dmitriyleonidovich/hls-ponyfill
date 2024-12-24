import { HLSPonyfill } from '../src';
import Hls from 'hls.js';

HLSPonyfill.Hls = Hls;

const videoEl = document.querySelectorAll('video')![0];
var hlsPony = new HLSPonyfill(videoEl);
hlsPony.setSrc('https://stands.s3.yandex.net/streams/subtitles-playlist-two-tracks/master.m3u8');



import { HLSPonyfillVideoElement } from '../src';

HLSPonyfillVideoElement.Hls = Hls;
HLSPonyfillVideoElement.install();