# Third-party software

DiscForge Studio's own code is released under the MIT License (see `LICENSE`).
The Windows installer also bundles the separate programs and components listed below.
They are independent programs that DiscForge Studio starts as child processes; each
keeps its own license, and its source code is available from the links given.

| Component | Used for | License | Source |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) (includes Chromium and Node.js) | Application runtime | MIT, plus Chromium's licenses (`LICENSES.chromium.html` in the install folder) | https://github.com/electron/electron |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) (Skia) | Menu and artwork rendering | MIT (Skia: BSD-3-Clause) | https://github.com/Brooooooklyn/canvas |
| [FFmpeg](https://ffmpeg.org/) (`ffmpeg.exe`, `ffprobe.exe`) - gyan.dev "release essentials" build | Decoding, encoding, analysis | GPL-3.0-or-later (this build includes GPL components such as x264/x265) | https://ffmpeg.org/download.html#get-sources - build details: https://www.gyan.dev/ffmpeg/builds/ |
| [tsMuxeR](https://github.com/justdan96/tsMuxer) 2.7.0 | Blu-ray / UHD multiplexing | Apache-2.0 | https://github.com/justdan96/tsMuxer |
| [dovi_tool](https://github.com/quietvoid/dovi_tool) 2.3.4 | Dolby Vision metadata | MIT | https://github.com/quietvoid/dovi_tool |
| [hdr10plus_tool](https://github.com/quietvoid/hdr10plus_tool) 1.7.2 | HDR10+ metadata | MIT | https://github.com/quietvoid/hdr10plus_tool |
| [dvdauthor and spumux](https://github.com/ldo/dvdauthor) (Windows build from DVDStyler) | DVD-Video authoring, DVD menu highlights and subtitles | GPL-2.0-or-later | https://github.com/ldo/dvdauthor and https://sourceforge.net/projects/dvdstyler/files/dvdstyler/ |
| libxml2, libiconv, liblzma, zlib, fontconfig, FreeType, FriBidi, libpng (DLLs used by dvdauthor/spumux) | Libraries for dvdauthor/spumux | MIT / LGPL-2.1+ / public domain / zlib / MIT / FTL or GPL-2.0 / LGPL-2.1+ / libpng | Distributed with DVDStyler; upstream projects at xmlsoft.org, gnu.org/software/libiconv, tukaani.org/xz, zlib.net, freedesktop.org/fontconfig, freetype.org, github.com/fribidi/fribidi, libpng.org |
| Inter, Lora and Poppins fonts | Menu text | SIL Open Font License 1.1 (`assets/fonts/OFL-*.txt`) | https://github.com/rsms/inter, https://github.com/cyrealtype/Lora-Cyrillic, https://github.com/itfoundry/Poppins |

Windows' own Image Mastering API (IMAPI2) is used for burning; it is part of Windows and is not redistributed.

If you redistribute the installer, you must keep this notice and comply with the licenses above
(in particular, the GPL requires that the corresponding source code of FFmpeg and dvdauthor be
available; the links above point to it).
