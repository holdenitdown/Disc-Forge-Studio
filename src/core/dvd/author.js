'use strict';
/**
 * DVD-Video authoring with dvdauthor + spumux.
 *
 * Register usage (GPRM):
 *   g1 : "play all" flag      g3 : selected audio stream (0-based)
 *   g4 : selected subtitle (SPRM2 value: 64+n = stream n shown, 0 = off)
 *   g5 : menu page to show when returning from a title (1-based vmgm menu)
 */
const fs = require('fs');
const path = require('path');
const { run, escapeXml, secToTimestamp, ensureDir } = require('../util');
const { FONT_DIR } = require('../encode/compose');

function dvdTime(sec) { return secToTimestamp(sec, '.').replace(/^00:/, '0:'); }

/** Encode one menu page background (still or motion) into a DVD MPEG-2 program stream. */
async function encodeMenuPage(ctx, tools, project, bgPng, outMpg, opts) {
  const ntsc = project.dvd.standard === 'ntsc';
  const W = 720;
  const H = ntsc ? 480 : 576;
  const fps = ntsc ? '30000/1001' : '25';
  const args = ['-y', '-hide_banner'];
  let duration = opts.duration || 1.5;
  if (opts.motionVideo) {
    args.push('-ss', String(opts.motionStart || 0), '-t', String(duration), '-i', opts.motionVideo, '-i', bgPng);
  } else {
    args.push('-loop', '1', '-framerate', fps, '-t', String(duration), '-i', bgPng);
  }
  if (opts.music) args.push('-ss', String(opts.musicStart || 0), '-t', String(duration), '-i', opts.music);
  else args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');
  const aIdx = opts.motionVideo ? 2 : 1;
  const vf = opts.motionVideo
    ? `[0:v]scale=${W}:${H},setsar=1,fps=${fps}[mv];[1:v]scale=${W}:${H}[art];[mv][art]overlay=0:0,setdar=${project.dvd.aspect === '4:3' ? '4/3' : '16/9'}[v]`
    : `[0:v]scale=${W}:${H}:flags=lanczos,fps=${fps},format=yuv420p,setdar=${project.dvd.aspect === '4:3' ? '4/3' : '16/9'}[v]`;
  const af = `[${aIdx}:a]aresample=48000,aformat=channel_layouts=stereo${opts.music && opts.volume != null ? `,volume=${opts.volume / 100}` : ''}${opts.music && opts.fadeIn ? ',afade=t=in:d=1.5' : ''}${opts.music && opts.fadeOut ? `,afade=t=out:st=${Math.max(0, duration - 2)}:d=2` : ''}[a]`;
  args.push('-filter_complex', `${vf};${af}`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'mpeg2video', '-b:v', '6000k', '-maxrate', '8000k', '-bufsize', '1835k', '-g', ntsc ? '18' : '15', '-bf', '0', '-qmin', '1', '-q:v', '2',
    '-c:a', 'ac3', '-b:a', '192k', '-aspect', project.dvd.aspect, '-t', String(duration), '-f', 'dvd', '-muxrate', '10080000', outMpg);
  await run(ctx, tools.ffmpeg, args);
  return outMpg;
}

/** spumux XML for menu highlights */
function spumuxMenuXml(project, masks, hlFile, selFile) {
  const fmt = project.dvd.standard === 'ntsc' ? 'NTSC' : 'PAL';
  const btn = masks.buttons.map((b) => {
    const nav = b.nav || {};
    const n = (id) => (id ? ` b${id}` : '').trim();
    return `      <button name="${b.name}" x0="${b.x0}" y0="${b.y0}" x1="${b.x1}" y1="${b.y1}"${nav.up ? ` up="${n(nav.up)}"` : ''}${nav.down ? ` down="${n(nav.down)}"` : ''}${nav.left ? ` left="${n(nav.left)}"` : ''}${nav.right ? ` right="${n(nav.right)}"` : ''}/>`;
  }).join('\n');
  return `<subpictures format="${fmt}">\n  <stream>\n    <spu start="00:00:00.00" force="yes" highlight="${escapeXml(hlFile)}" select="${escapeXml(selFile)}">\n${btn}\n    </spu>\n  </stream>\n</subpictures>\n`;
}

async function spumux(ctx, tools, xmlFile, inFile, outFile, streamNo = 0, extraArgs = []) {
  const input = fs.openSync(inFile, 'r');
  const output = fs.openSync(outFile, 'w');
  try {
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      ctx.log(`$ spumux -s ${streamNo} ${extraArgs.join(' ')} ${xmlFile} < ${inFile} > ${outFile}`);
      const child = spawn(tools.spumux, ['-s', String(streamNo), ...extraArgs, xmlFile], { stdio: [input, output, 'pipe'], windowsHide: true, cwd: path.dirname(xmlFile) });
      ctx.children.add(child);
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
      child.on('error', reject);
      child.on('close', (code) => {
        ctx.children.delete(child);
        if (ctx.cancelled) return reject(new Error('Cancelled'));
        if (code !== 0) return reject(new Error(`spumux failed: ${err.split('\n').filter((l) => /ERR|WARN/i.test(l)).slice(-5).join('\n') || err.slice(-500)}`));
        ctx.log(err.split('\n').filter((l) => /INFO: \d+ subtitles|buttons|WARN/i.test(l)).slice(-4).join('\n'));
        resolve();
      });
    });
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/** Add text subtitles to a title program stream with spumux textsub. */
async function addTextSubtitles(ctx, tools, project, mpg, subs, workDir) {
  let cur = mpg;
  const ntsc = project.dvd.standard === 'ntsc';
  // spumux opens an absolute font path directly with FreeType on every platform
  const fontFile = path.join(FONT_DIR, 'Inter-SemiBold.otf').replace(/\\/g, '/');
  for (const [i, s] of subs.entries()) {
    const xml = path.join(workDir, `${path.basename(mpg, '.mpg')}_sub${i}.xml`);
    const fps = ntsc ? '29.97' : '25';
    fs.writeFileSync(xml, `<subpictures format="${ntsc ? 'NTSC' : 'PAL'}">\n  <stream>\n    <textsub filename="${escapeXml(s.file)}" characterset="UTF-8" fontsize="${ntsc ? 26 : 28}.0" font="${escapeXml(fontFile)}" fill-color="rgba(255,255,255,255)" outline-color="rgba(0,0,0,255)" outline-thickness="2.0" horizontal-alignment="center" vertical-alignment="bottom" bottom-margin="${ntsc ? 28 : 34}" left-margin="40" right-margin="40" subtitle-fps="${fps}" movie-fps="${fps}" movie-width="720" movie-height="${ntsc ? 478 : 574}"${s.forced ? ' force="yes"' : ''}/>\n  </stream>\n</subpictures>\n`);
    const out = path.join(workDir, `${path.basename(mpg, '.mpg')}_s${i}.mpg`);
    await spumux(ctx, tools, xml, cur, out, i);
    if (cur !== mpg) fs.rmSync(cur, { force: true });
    cur = out;
  }
  return cur;
}

/**
 * Build the DVD.
 * plan: { titles: [{ number, mpg, chapters:[sec], audio:[{lang}], subs:[{lang}], bonus, next }], menuPages: [{ page, mpg }] , layout }
 */
async function authorDvd(ctx, tools, project, plan, outRoot) {
  const ntsc = project.dvd.standard === 'ntsc';
  const fmt = ntsc ? 'ntsc' : 'pal';
  const aspect = project.dvd.aspect;
  const wide = aspect === '16:9' ? ' widescreen="nopanscan"' : '';
  const menusOn = project.menu.enabled && plan.menuPages.length > 0;
  const titles = plan.titles;
  const maxAudio = Math.max(1, ...titles.map((t) => t.audio.length));
  const maxSubs = Math.max(0, ...titles.map((t) => t.subs.length));
  const defAudio = Math.max(0, Math.min(maxAudio, project.output.defaultAudio || 1) - 1);
  const defSub = project.output.defaultSubtitle > 0 && project.output.defaultSubtitle <= maxSubs ? 64 + project.output.defaultSubtitle - 1 : 0;
  const lang2 = (l) => ({ eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', jpn: 'ja', chi: 'zh', zho: 'zh', por: 'pt', rus: 'ru', kor: 'ko', dut: 'nl', nld: 'nl', swe: 'sv', pol: 'pl' }[l] || (l && l !== 'und' ? l.slice(0, 2) : 'en'));
  const firstMain = titles.find((t) => !t.bonus) || titles[0];

  const buttonCommand = (action) => {
    switch (action.type) {
      case 'play': return `g1=0; jump title ${action.title} chapter ${action.chapter + 1};`;
      case 'playAll': return `g1=1; jump title ${action.title} chapter 1;`;
      case 'page': return `jump menu ${action.pageIndex + 1};`;
      case 'audio': return `g3=${action.track - 1}; jump menu 1;`;
      case 'subtitle': return `g4=${action.track > 0 ? 64 + action.track - 1 : 0}; jump menu 1;`;
      default: return 'jump menu 1;';
    }
  };

  let xml = `<dvdauthor dest="${escapeXml(outRoot)}" jumppad="yes">\n  <vmgm>\n`;
  const intro = plan.firstPlayTitle;
  const fpc = [`g3=${defAudio};`, `g4=${defSub};`, 'g1=0;'];
  if (intro) fpc.push(`g6=1; jump title ${intro};`);
  else if (!menusOn || project.menu.skipMenu) fpc.push(`g1=${titles.length > 1 && project.encoding.loopWithoutMenu ? 1 : 0}; jump title ${firstMain.number};`);
  else fpc.push('jump menu 1;');
  xml += `    <fpc>{ ${fpc.join(' ')} }</fpc>\n`;
  if (menusOn) {
    xml += `    <menus>\n      <video format="${fmt}" aspect="${aspect}"${wide}/>\n      <audio lang="en"/>\n      <subpicture>\n        <stream id="0" mode="${aspect === '16:9' ? 'widescreen' : 'normal'}"/>\n      </subpicture>\n`;
    plan.menuPages.forEach((mp, i) => {
      xml += `      <pgc${i === 0 ? ' entry="title"' : ''}>\n`;
      xml += `        <vob file="${escapeXml(mp.mpg)}"${mp.still ? ' pause="inf"' : ''}/>\n`;
      for (const b of mp.page.buttons) xml += `        <button name="b${b.id}">{ ${buttonCommand(b.action)} }</button>\n`;
      xml += `        <post>jump cell 1;</post>\n`; // motion menus loop; stills re-enter if a player ends the still
      xml += '      </pgc>\n';
    });
    xml += '    </menus>\n';
  }
  xml += '  </vmgm>\n  <titleset>\n';
  // titleset root menu: Menu key during playback returns to the main menu
  xml += `    <menus>\n      <video format="${fmt}" aspect="${aspect}"${wide}/>\n      <pgc entry="root">\n        <pre>{ ${menusOn ? 'jump vmgm menu 1;' : `jump title ${firstMain.number};`} }</pre>\n        <vob file="${escapeXml(plan.blankMpg)}" pause="0"/>\n      </pgc>\n    </menus>\n`;
  xml += `    <titles>\n      <video format="${fmt}" aspect="${aspect}"${wide}/>\n`;
  for (let i = 0; i < maxAudio; i++) xml += `      <audio lang="${lang2(firstMain.audio[i] ? firstMain.audio[i].lang : 'und')}"/>\n`;
  if (maxSubs) {
    for (let i = 0; i < maxSubs; i++) xml += `      <subpicture lang="${lang2(firstMain.subs[i] ? firstMain.subs[i].lang : 'und')}"><stream id="${i}" mode="${aspect === '16:9' ? 'widescreen' : 'normal'}"/></subpicture>\n`;
  }
  const mains = titles.filter((t) => !t.bonus);
  for (const t of titles) {
    const chapters = t.chapters.map(dvdTime).join(',');
    const nextMain = !t.bonus ? mains[mains.indexOf(t) + 1] : null;
    const post = [];
    if (intro && t.number === intro) {
      post.push(menusOn && !project.menu.skipMenu ? 'call vmgm menu 1;' : `jump title ${firstMain.number};`);
    } else {
      if (nextMain) post.push(`if (g1 == 1) jump title ${nextMain.number};`);
      if (menusOn) post.push('call vmgm menu 1;');
      else if (project.encoding.loopWithoutMenu) post.push(`jump title ${nextMain ? nextMain.number : firstMain.number};`);
      else post.push('exit;');
    }
    xml += `      <pgc>\n        <pre>{ audio=g3; subtitle=g4; }</pre>\n        <vob file="${escapeXml(t.mpg)}" chapters="${chapters}"/>\n        <post>{ ${post.join(' ')} }</post>\n      </pgc>\n`;
  }
  xml += '    </titles>\n  </titleset>\n</dvdauthor>\n';
  const xmlFile = path.join(path.dirname(outRoot), 'dvdauthor.xml');
  fs.writeFileSync(xmlFile, xml);
  fs.rmSync(outRoot, { recursive: true, force: true });
  await run(ctx, tools.dvdauthor, ['-x', xmlFile], { env: { VIDEO_FORMAT: ntsc ? 'NTSC' : 'PAL' } });
  return outRoot;
}

/** Tiny black clip used for the titleset root menu. */
async function makeBlank(ctx, tools, project, out) {
  const ntsc = project.dvd.standard === 'ntsc';
  await run(ctx, tools.ffmpeg, ['-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=black:s=720x${ntsc ? 480 : 576}:r=${ntsc ? '30000/1001' : '25'}:d=0.5`,
    '-f', 'lavfi', '-t', '0.5', '-i', 'anullsrc=r=48000:cl=stereo', '-c:v', 'mpeg2video', '-b:v', '2000k', '-c:a', 'ac3', '-b:a', '128k',
    '-aspect', project.dvd.aspect, '-f', 'dvd', out]);
  return out;
}

module.exports = { encodeMenuPage, spumuxMenuXml, spumux, addTextSubtitles, authorDvd, makeBlank, dvdTime };
