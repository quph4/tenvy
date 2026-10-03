# Third-party software

Tenvy bundles the following independently licensed programs. They run as
separate processes and are distributed alongside Tenvy, not linked into it.
The full license texts are installed in the `licenses` folder next to
Tenvy (Settings → About → Open-source licenses).

## mpv

- Project: https://mpv.io — source: https://github.com/mpv-player/mpv
- Windows build: https://github.com/shinchiro/mpv-winbuild-cmake
- Installed as `mpv\mpv.exe` in the Tenvy installation folder; its exact
  version is printed by `mpv.exe --version`.
- License: GPL-2.0-or-later. The Windows build also contains libraries
  (such as FFmpeg) under the GPL and LGPL; the combined program may be
  covered by GPL-3.0. See `GPL-2.0.txt`, `GPL-3.0.txt` and `LGPL-2.1.txt`.

mpv is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 2 of the License, or (at your option) any
later version. It is distributed WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

### Source code

The source code of mpv and of the build scripts used to produce the
bundled binary is available at the links above.

**Written offer.** For at least three years after we last distribute a
given version of Tenvy, we will provide anyone who asks the complete
corresponding source code of the mpv build shipped with it, on a medium
customarily used for software interchange, for no more than our cost of
physically performing the distribution. Ask at
https://github.com/quph4/tenvy-releases/issues and name the Tenvy version.

Each Tenvy release ships an mpv build pinned by URL and SHA-256 in the
release workflow (repository variables `MPV_URL` / `MPV_SHA256`).

## Frontend and Rust dependencies

Tenvy's own JavaScript and Rust dependencies are permissively licensed
(MIT / Apache-2.0 / BSD / ISC / Zlib / Unicode). A generated list can be
produced with `cargo about` (Rust) and `pnpm licenses list` (JavaScript).
