'use strict';
/**
 * Original DiscForge menu themes. Backgrounds are painted procedurally on a canvas
 * so they look crisp at every disc resolution (DVD up to 4K UHD).
 * Each painter receives (ctx, W, H, rand) where rand is a seeded PRNG.
 */

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function linear(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}

function radial(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}

function bokeh(ctx, W, H, rand, n, colors, maxR) {
  for (let i = 0; i < n; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = (0.2 + rand() * 0.8) * maxR;
    ctx.fillStyle = radial(ctx, x, y, 0, r, [[0, colors[i % colors.length]], [1, 'rgba(0,0,0,0)']]);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

function vignette(ctx, W, H, strength = 0.55) {
  ctx.fillStyle = radial(ctx, W / 2, H / 2, Math.min(W, H) * 0.35, Math.max(W, H) * 0.75, [[0, 'rgba(0,0,0,0)'], [1, `rgba(0,0,0,${strength})`]]);
  ctx.fillRect(0, 0, W, H);
}

const THEMES = {
  aurora: {
    name: 'Aurora',
    layout: 'left',
    fonts: { title: 'Poppins', body: 'Inter' },
    colors: { title: '#ffffff', text: '#e8f1ff', accent: '#7cf5d4', panel: 'rgba(6,14,32,0.45)', highlight: '#7cf5d4' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#040b1f'], [0.55, '#0b1d3f'], [1, '#132a4d']]);
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.6})`;
        const s = rand() * 1.6 * (H / 1080) + 0.4;
        ctx.fillRect(rand() * W, rand() * H * 0.7, s, s);
      }
      ctx.globalCompositeOperation = 'screen';
      const ribbons = [['rgba(60,255,190,0.35)', 0.32], ['rgba(90,170,255,0.30)', 0.4], ['rgba(190,110,255,0.22)', 0.24]];
      ribbons.forEach(([c, yb], k) => {
        for (let layer = 0; layer < 18; layer++) {
          ctx.beginPath();
          const off = layer * H * 0.006;
          ctx.moveTo(0, H * yb + off);
          for (let x = 0; x <= W; x += W / 40) {
            const y = H * yb + Math.sin(x / W * Math.PI * (2 + k) + k) * H * 0.08 + Math.sin(x / W * 11 + layer) * H * 0.01 + off;
            ctx.lineTo(x, y);
          }
          ctx.strokeStyle = c.replace(/[\d.]+\)$/, `${0.05 + 0.02 * (18 - layer) / 18})`);
          ctx.lineWidth = H * 0.03;
          ctx.stroke();
        }
      });
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = linear(ctx, 0, H * 0.78, 0, H, [[0, 'rgba(3,8,20,0)'], [1, 'rgba(3,8,20,0.95)']]);
      ctx.fillRect(0, H * 0.7, W, H * 0.3);
      ctx.fillStyle = '#030a18';
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += W / 24) ctx.lineTo(x, H * (0.9 - 0.05 * Math.abs(Math.sin(x / W * 7)) - rand() * 0.015));
      ctx.lineTo(W, H); ctx.fill();
    },
  },
  cinema: {
    name: 'Premiere',
    layout: 'center',
    fonts: { title: 'Lora', body: 'Inter' },
    colors: { title: '#f7d58b', text: '#f5ead2', accent: '#f7d58b', panel: 'rgba(20,4,6,0.5)', highlight: '#f7d58b' },
    paint(ctx, W, H) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#2a0508'], [1, '#100103']]);
      ctx.fillRect(0, 0, W, H);
      const folds = 26;
      for (let i = 0; i < folds; i++) {
        const x = (i / folds) * W;
        ctx.fillStyle = linear(ctx, x, 0, x + W / folds, 0, [[0, 'rgba(0,0,0,0.35)'], [0.5, 'rgba(255,60,70,0.12)'], [1, 'rgba(0,0,0,0.35)']]);
        ctx.fillRect(x, 0, W / folds + 1, H);
      }
      ctx.fillStyle = radial(ctx, W / 2, H * 0.12, 0, W * 0.6, [[0, 'rgba(255,220,150,0.35)'], [1, 'rgba(0,0,0,0)']]);
      ctx.fillRect(0, 0, W, H);
      vignette(ctx, W, H, 0.7);
      ctx.strokeStyle = 'rgba(247,213,139,0.6)';
      ctx.lineWidth = H * 0.003;
      ctx.strokeRect(W * 0.03, H * 0.05, W * 0.94, H * 0.9);
    },
  },
  minimal: {
    name: 'Gallery White',
    layout: 'left',
    fonts: { title: 'Poppins', body: 'Inter' },
    colors: { title: '#14161a', text: '#2a2d33', accent: '#2f6bff', panel: 'rgba(255,255,255,0.7)', highlight: '#2f6bff', dark: false },
    paint(ctx, W, H) {
      ctx.fillStyle = linear(ctx, 0, 0, W, H, [[0, '#fbfbfc'], [1, '#e9ecf1']]);
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(47,107,255,0.08)';
      ctx.beginPath(); ctx.arc(W * 0.86, H * 0.2, H * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(20,22,26,0.05)';
      ctx.beginPath(); ctx.arc(W * 0.7, H * 0.95, H * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2f6bff';
      ctx.fillRect(W * 0.06, H * 0.12, W * 0.004, H * 0.11);
    },
  },
  neon: {
    name: 'Neon Drive',
    layout: 'left',
    fonts: { title: 'Poppins', body: 'Inter' },
    colors: { title: '#ff4fd8', text: '#e9e3ff', accent: '#29e7ff', panel: 'rgba(12,3,30,0.55)', highlight: '#29e7ff' },
    paint(ctx, W, H) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#0b0221'], [0.59, '#2b0a4a'], [0.6, '#12002b'], [1, '#05000f']]);
      ctx.fillRect(0, 0, W, H);
      const sunY = H * 0.6;
      const sunX = W * 0.7;
      ctx.fillStyle = linear(ctx, 0, sunY - H * 0.28, 0, sunY, [[0, '#ffd54a'], [1, '#ff2d95']]);
      ctx.beginPath(); ctx.arc(sunX, sunY, H * 0.26, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#12002b';
      for (let i = 0; i < 7; i++) ctx.fillRect(sunX - H * 0.3, sunY - H * 0.02 - i * H * 0.034, H * 0.6, H * 0.006 + i * 0.0015 * H);
      ctx.strokeStyle = 'rgba(41,231,255,0.55)';
      ctx.lineWidth = Math.max(1, H * 0.002);
      for (let i = 1; i < 14; i++) {
        const y = sunY + (H - sunY) * Math.pow(i / 13, 2);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      for (let i = -12; i <= 12; i++) {
        ctx.beginPath(); ctx.moveTo(sunX + i * W * 0.02, sunY); ctx.lineTo(sunX + i * W * 0.16, H); ctx.stroke();
      }
    },
  },
  ocean: {
    name: 'Deep Blue',
    layout: 'bottom',
    fonts: { title: 'Poppins', body: 'Inter' },
    colors: { title: '#ffffff', text: '#e6f6ff', accent: '#5fd3ff', panel: 'rgba(0,30,60,0.45)', highlight: '#5fd3ff' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#0a6aa8'], [0.45, '#044a7d'], [1, '#011a35']]);
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 9; i++) {
        const x = W * (0.1 + 0.1 * i) + rand() * W * 0.05;
        ctx.fillStyle = linear(ctx, x, 0, x + W * 0.05, H, [[0, 'rgba(160,230,255,0.18)'], [1, 'rgba(160,230,255,0)']]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + W * 0.04, 0); ctx.lineTo(x + W * 0.16, H); ctx.lineTo(x + W * 0.07, H); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      bokeh(ctx, W, H, rand, 50, ['rgba(200,240,255,0.25)', 'rgba(120,210,255,0.18)'], H * 0.02);
      vignette(ctx, W, H, 0.5);
    },
  },
  sunset: {
    name: 'Golden Hour',
    layout: 'left',
    fonts: { title: 'Lora', body: 'Inter' },
    colors: { title: '#fff4e3', text: '#fff1df', accent: '#ffd38a', panel: 'rgba(60,20,10,0.35)', highlight: '#ffe1a8' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#2b1748'], [0.35, '#a8466a'], [0.62, '#f2955a'], [0.8, '#ffc77d'], [1, '#3a1d2a']]);
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = radial(ctx, W * 0.72, H * 0.66, 0, H * 0.5, [[0, 'rgba(255,240,200,0.95)'], [0.18, 'rgba(255,210,140,0.7)'], [1, 'rgba(255,160,90,0)']]);
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(40,16,30,0.9)';
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += W / 30) ctx.lineTo(x, H * (0.8 + 0.04 * Math.sin(x / W * 5) + rand() * 0.01));
      ctx.lineTo(W, H); ctx.fill();
    },
  },
  forest: {
    name: 'Evergreen',
    layout: 'bottom',
    fonts: { title: 'Lora', body: 'Inter' },
    colors: { title: '#f4f7ec', text: '#eef3e6', accent: '#c6e98b', panel: 'rgba(10,24,12,0.45)', highlight: '#d8f59a' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#24452f'], [1, '#08150c']]);
      ctx.fillRect(0, 0, W, H);
      bokeh(ctx, W, H, rand, 70, ['rgba(220,255,170,0.22)', 'rgba(255,240,180,0.18)', 'rgba(140,220,140,0.15)'], H * 0.07);
      for (let layer = 0; layer < 3; layer++) {
        ctx.fillStyle = ['rgba(8,30,15,0.55)', 'rgba(5,22,10,0.75)', 'rgba(3,12,6,0.95)'][layer];
        for (let i = 0; i < 16; i++) {
          const x = rand() * W;
          const h = H * (0.25 + layer * 0.12 + rand() * 0.15);
          const w = h * 0.32;
          ctx.beginPath(); ctx.moveTo(x, H - h); ctx.lineTo(x - w, H); ctx.lineTo(x + w, H); ctx.fill();
        }
      }
    },
  },
  celebration: {
    name: 'Celebration',
    layout: 'center',
    fonts: { title: 'Poppins', body: 'Inter' },
    colors: { title: '#ffffff', text: '#fff6fb', accent: '#ffd166', panel: 'rgba(40,10,50,0.4)', highlight: '#ffd166' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, W, H, [[0, '#5b2a86'], [0.5, '#9a3f8f'], [1, '#e2607a']]);
      ctx.fillRect(0, 0, W, H);
      bokeh(ctx, W, H, rand, 40, ['rgba(255,255,255,0.2)', 'rgba(255,210,120,0.25)'], H * 0.06);
      const cols = ['#ffd166', '#06d6a0', '#ef476f', '#4cc9f0', '#ffffff'];
      for (let i = 0; i < 160; i++) {
        ctx.save();
        ctx.translate(rand() * W, rand() * H);
        ctx.rotate(rand() * Math.PI);
        ctx.fillStyle = cols[i % cols.length];
        ctx.globalAlpha = 0.55 + rand() * 0.4;
        const s = H * (0.006 + rand() * 0.008);
        ctx.fillRect(-s, -s / 2.5, s * 2, s / 1.25);
        ctx.restore();
      }
      vignette(ctx, W, H, 0.35);
    },
  },
  filmstrip: {
    name: 'Home Movies',
    layout: 'left',
    fonts: { title: 'Lora', body: 'Inter' },
    colors: { title: '#fdf1d8', text: '#f3e6cc', accent: '#ffcf70', panel: 'rgba(40,26,12,0.45)', highlight: '#ffcf70' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, W, H, [[0, '#6b4a2a'], [1, '#2a1a0d']]);
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 1800; i++) {
        ctx.fillStyle = `rgba(255,240,210,${rand() * 0.05})`;
        ctx.fillRect(rand() * W, rand() * H, 2, 2);
      }
      const band = H * 0.08;
      ctx.fillStyle = '#120b05';
      ctx.fillRect(0, 0, W, band); ctx.fillRect(0, H - band, W, band);
      ctx.fillStyle = '#e9dcc0';
      const hole = band * 0.42;
      for (let x = hole; x < W; x += hole * 2.2) {
        ctx.fillRect(x, (band - hole) / 2, hole, hole);
        ctx.fillRect(x, H - band + (band - hole) / 2, hole, hole);
      }
      vignette(ctx, W, H, 0.6);
    },
  },
  cosmos: {
    name: 'Cosmos',
    layout: 'right',
    fonts: { title: 'Poppins', body: 'Inter' },
    colors: { title: '#ffffff', text: '#dfe6ff', accent: '#9db4ff', panel: 'rgba(5,8,25,0.45)', highlight: '#b8c8ff' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = '#03040c';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = radial(ctx, W * 0.3, H * 0.4, 0, W * 0.6, [[0, 'rgba(90,60,200,0.35)'], [1, 'rgba(0,0,0,0)']]);
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = radial(ctx, W * 0.75, H * 0.75, 0, W * 0.4, [[0, 'rgba(40,140,220,0.25)'], [1, 'rgba(0,0,0,0)']]);
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 700; i++) {
        ctx.fillStyle = `rgba(255,255,255,${rand() * 0.9})`;
        const s = rand() < 0.97 ? 1 : 2.5;
        ctx.fillRect(rand() * W, rand() * H, s * H / 1080, s * H / 1080);
      }
      const px = W * 0.22, py = H * 0.62, pr = H * 0.32;
      ctx.fillStyle = radial(ctx, px - pr * 0.4, py - pr * 0.4, pr * 0.1, pr * 1.1, [[0, '#6a8cff'], [0.6, '#24307a'], [1, '#05071a']]);
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(200,210,255,0.35)';
      ctx.lineWidth = H * 0.006;
      ctx.beginPath(); ctx.ellipse(px, py, pr * 1.7, pr * 0.32, -0.25, 0, Math.PI * 2); ctx.stroke();
    },
  },
  frost: {
    name: 'First Snow',
    layout: 'center',
    fonts: { title: 'Lora', body: 'Inter' },
    colors: { title: '#ffffff', text: '#f1f7ff', accent: '#bfe3ff', panel: 'rgba(20,40,70,0.35)', highlight: '#e0f1ff' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, 0, H, [[0, '#26456e'], [1, '#8fb2d6']]);
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += W / 20) ctx.lineTo(x, H * (0.86 + 0.03 * Math.sin(x / W * 4)));
      ctx.lineTo(W, H); ctx.fill();
      for (let i = 0; i < 260; i++) {
        const r = (0.5 + rand() * 2.5) * H / 1080;
        ctx.fillStyle = `rgba(255,255,255,${0.4 + rand() * 0.5})`;
        ctx.beginPath(); ctx.arc(rand() * W, rand() * H, r, 0, Math.PI * 2); ctx.fill();
      }
    },
  },
  playful: {
    name: 'Bubbles',
    layout: 'bottom',
    fonts: { title: 'Poppins', body: 'Poppins' },
    colors: { title: '#ffffff', text: '#ffffff', accent: '#ffe066', panel: 'rgba(30,60,120,0.35)', highlight: '#ffe066' },
    paint(ctx, W, H, rand) {
      ctx.fillStyle = linear(ctx, 0, 0, W, H, [[0, '#36a3ff'], [1, '#7c4dff']]);
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 40; i++) {
        const x = rand() * W, y = rand() * H, r = H * (0.02 + rand() * 0.09);
        ctx.fillStyle = radial(ctx, x - r * 0.3, y - r * 0.3, r * 0.05, r, [[0, 'rgba(255,255,255,0.45)'], [0.7, 'rgba(255,255,255,0.08)'], [1, 'rgba(255,255,255,0.25)']]);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    },
  },
};

module.exports = { THEMES, seeded };
