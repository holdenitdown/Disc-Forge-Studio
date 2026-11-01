# DiscForge Studio

Author **DVD**, **Blu-ray** and **4K UHD Blu-ray** discs with interactive menus from your own videos, photo slideshows and music, then burn them, all in one modern Windows app.

- Real interactive menus on every format: DVD menus with highlight buttons, Blu-ray **HDMV interactive graphics** with a **pop-up menu** during playback, scene selection, audio and subtitle pages.
- Re-encodes anything FFmpeg can read to the exact format each disc needs (or passes compliant video straight through).
- Builds standards-compliant disc images and burns them with live progress (speed, buffer, time left).

> Windows 10/11 (64-bit). Free and open source under the MIT License.

## Download

Get **`DiscForge-Studio-Setup-x.y.z.exe`** from the [Releases](../../releases) page and run it.
The installer needs no administrator rights (it installs for the current user by default; you can pick another folder), adds Start-menu and desktop shortcuts and an uninstaller, and bundles every tool the app needs: FFmpeg, tsMuxeR, dvdauthor/spumux, dovi_tool and hdr10plus_tool.

## Features

**Media**
- Videos: trim, chapters (every N minutes, custom list, or imported), audio track selection and languages, external SRT/ASS/SUP subtitles, volume.
- Photo **slideshows**: 25 transitions, Ken Burns motion, blurred-fill framing, background music with fades.
- **Music albums**: cover art, track titles, animated waveform, one chapter per track.
- Bonus items and drag-to-reorder.

**Formats**
- **DVD-5 / DVD-9**, NTSC or PAL, 16:9 or 4:3 (MPEG-2, AC-3; telecine for film sources). Picture fit: keep shape, zoom to fill, or stretch.
- **Blu-ray** 1080p / 1080i / 720p (H.264, Blu-ray-legal frame rates including PsF).
- **4K UHD Blu-ray** (HEVC Main10): HDR10 with mastering metadata, HDR10+ and Dolby Vision profile 8.1 passthrough, HDR-to-SDR tone-mapping.
- Passthrough for sources that are already compliant; copy or encode audio (AC-3, LPCM, DTS, TrueHD, E-AC-3).
- GPU encoding with NVIDIA NVENC, Intel Quick Sync or AMD AMF, falling back to x264/x265.

**Menus**
- 12 original themes, rendered at the disc's resolution.
- Main, titles, scenes (thumbnails or text), audio, subtitles and bonus pages, with pagination.
- Custom background image or motion video, background music, highlight styles and colours, draggable buttons, your own text and images, first-play intro, skip-menu option.

**Output**
- Disc folder (`VIDEO_TS` / `BDMV`), ISO image, burn to disc (copies, write speed), erase rewritable discs.
- Test disc (first 5 minutes of each title), shut down when finished, detailed logs.

## How it works

`src/core` is the authoring engine (plain Node.js, no Electron dependency):

| Path | What it does |
|---|---|
| `encode/` | FFmpeg profiles for each disc format; slideshow and music-album rendering |
| `menu/` | Themes, page layout and remote-control navigation, Skia rendering, Blu-ray pop-up menu |
| `dvd/author.js` | dvdauthor / spumux XML and DVD virtual-machine commands |
| `bd/` | HDMV command encoder, Interactive Graphics stream encoder (palette quantiser, RLE, ICS/PDS/ODS segments), tsMuxeR orchestration, MPEG-TS/CLPI/MPLS patching, `index.bdmv` and `MovieObject.bdmv` writers |
| `dvdiso.js` | DVD-Video disc image writer (ISO 9660 + UDF 1.02 bridge) with the contiguous IFO/VOB/BUP layout standalone players require |
| `disc.js` | ISO creation, burner listing, burning and erasing |
| `pipeline.js` | The end-to-end job, with progress and cancellation |

`native/dfburn/dfburn.cpp` is a small Windows helper that drives the built-in **Image Mastering API (IMAPI2)** directly and reports burn progress as JSON lines; `native/prebuilt/dfburn.exe` is a prebuilt copy.

The UI (`src/main`, `src/renderer`) is a plain Electron app: no framework, no bundler.

## Building from source

Requirements: **Windows 10/11 x64**, **Node.js 20+** (22 LTS recommended) and **DVDStyler 3.2+** installed (the build copies dvdauthor/spumux from it; set `DVDSTYLER_DIR` if it lives somewhere unusual).

```bat
git clone https://github.com/OWNER/DiscForge-Studio.git
cd DiscForge-Studio
npm ci
npm start            REM run from source (uses tools found on the PC)
npm run dist         REM build dist\DiscForge-Studio-Setup-<version>.exe
```

Or just double-click **`Build Installer.cmd`**.

`npm run dist` first runs `scripts/fetch-tools.js`, which downloads FFmpeg, tsMuxeR, dovi_tool and hdr10plus_tool (cached in `vendor/cache`), copies dvdauthor/spumux and the burning helper into `vendor/tools`, and then electron-builder packages everything into an NSIS installer.

To rebuild the burning helper (optional), on Windows with MSYS2/MinGW-w64, or on Linux with `g++-mingw-w64`:

```sh
x86_64-w64-mingw32-g++ -O2 -std=c++17 -municode -static -static-libgcc -static-libstdc++ \
  native/dfburn/dfburn.cpp -o native/build/dfburn.exe -lole32 -loleaut32 -lshlwapi -luuid
```

`fetch-tools` prefers `native/build/dfburn.exe` over the prebuilt copy when it exists.

### Continuous integration

`.github/workflows/build.yml` builds the installer on every push and pull request (it installs DVDStyler with Chocolatey and compiles `dfburn.exe` with MinGW). Pushing a tag such as `v1.0.0` also publishes the installer to a GitHub Release.

## Testing

The engine was verified by authoring discs and driving them with **libbluray** and **libdvdnav** (the engines inside VLC and Kodi): menus draw, remote navigation works, chapter and scene buttons, audio and subtitle selection, pop-up menus and 4K UHD HDR10.

- `test/e2e.js <dvd|bd|uhd> <media folder> <output folder>` authors a sample disc (needs FFmpeg, tsMuxeR and dvdauthor on the PATH).
- `test/bdplay.c` and `test/dvdplay.c` drive a disc folder through libbluray / libdvdnav from the command line.
- `test/verify_dvd_iso.py <image.iso>` checks a DVD image with an independent UDF reader and confirms every IFO sector pointer matches the real file positions.

## Notes

- Unencrypted 4K UHD BD-R discs play in many, but not all, standalone UHD players (some require AACS 2.0, which no home authoring tool can add).
- Some older DVD players do not read DVD+R DL discs; single-layer DVD-R is the most compatible.
- Only author and burn material you have the right to use.

## License

DiscForge Studio is released under the [MIT License](LICENSE). The installer bundles third-party programs under their own licenses (GPL, Apache-2.0, MIT, OFL); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
