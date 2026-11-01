/* End-to-end authoring test: node test/e2e.js <dvd|bd|uhd> <mediaDir> <outDir> [--popup] */
const path = require('path');
const { JobContext } = require('../src/core/util');
const { locateTools, detectEncoders } = require('../src/core/tools');
const { probe } = require('../src/core/probe');
const P = require('../src/core/project');
const { authorProject } = require('../src/core/pipeline');

(async () => {
  const [fmt, media, outRoot] = process.argv.slice(2);
  const tools = locateTools();
  const caps = await detectEncoders(tools.ffmpeg);
  const project = P.defaultProject();
  project.format = fmt;
  project.name = 'DiscForge E2E';
  project.menu.title = 'DiscForge Test Disc';
  project.menu.theme = process.env.THEME || 'aurora';
  project.menu.itemsPerPage = 4;
  project.output = { ...project.output, label: `E2E_${fmt.toUpperCase()}`, folder: outRoot, makeFolder: true, makeIso: fmt === 'dvd', overwrite: true };
  project.encoding.quality = 'standard';
  const v1 = P.newVideoItem(await probe(tools, path.join(media, 'v1.mkv')));
  v1.chapters = { mode: 'interval', interval: 10, list: [] };
  const v2 = P.newVideoItem(await probe(tools, path.join(media, 'v2.mp4')));
  v2.title = 'Color Bars';
  const bonus = P.newVideoItem(await probe(tools, path.join(media, 'bonus.mp4')));
  bonus.bonus = true;
  bonus.title = 'Making Of';
  const ss = P.newSlideshowItem(['img1.jpg', 'img2.jpg', 'img3.jpg', 'img4.jpg'].map((f) => path.join(media, f)));
  ss.slideshow.slideDuration = 3;
  ss.slideshow.music = [{ file: path.join(media, 'song1.mp3') }];
  const mu = P.newMusicItem([await probe(tools, path.join(media, 'song1.mp3')), await probe(tools, path.join(media, 'song2.mp3'))]);
  mu.title = 'Soundtrack';
  project.items = process.env.QUICK ? [v1, bonus] : [v1, v2, ss, mu, bonus];
  if (process.env.HDR) {
    const h = P.newVideoItem(await probe(tools, path.join(media, 'hdr.mkv')));
    h.title = 'HDR Demo';
    h.chapters = { mode: 'interval', interval: 3, list: [] };
    project.items = [h];
    if (process.env.PASS) { project.processing = 'passthrough'; project.audioMode = 'copy'; }
  }
  if (process.env.MENU_MUSIC) project.menu.music.file = path.join(media, 'song2.mp3');
  const t0 = Date.now();
  const ctx = new JobContext({
    onProgress: (p) => { if (process.env.VERBOSE) process.stdout.write(`\r${(p.overall * 100).toFixed(1)}% ${p.step}            `); },
    onLog: (l) => { if (process.env.VERBOSE) console.log(l); },
  });
  try {
    const res = await authorProject(project, { tools, caps, ctx });
    console.log('\nRESULT', JSON.stringify(res), `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    console.error('\nFAILED', e.message);
    process.exit(1);
  }
})();
