# Publishing to winget

`winget install oniolivvs.MusicPlayer` works once the manifests in this folder are
accepted into [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).

**Prerequisite:** the GitHub Release assets must be **publicly downloadable**
(a public repo, or a public release). winget cannot fetch from a private repo.

## Option A — automatic on release (recommended)

Add a fork PAT as the `WINGET_TOKEN` secret, then append this job to
`.github/workflows/release.yml`:

```yaml
  winget:
    needs: build
    runs-on: windows-latest
    steps:
      - uses: vedantmgoyal2009/winget-releaser@v2
        with:
          identifier: oniolivvs.MusicPlayer
          installers-regex: '-setup\.exe$'
          token: ${{ secrets.WINGET_TOKEN }}
```

It reads the release tag, computes the SHA256, fills the manifests and opens the
PR to winget-pkgs for you.

## Option B — manual

1. Build the release (push a `v*` tag) and grab the `*-setup.exe` URL.
2. `sha256sum` the installer.
3. In the three YAML files, replace `__VERSION__` (e.g. `0.9.2`), `__URL__`
   (the installer URL) and `__SHA256__` (uppercase hex).
4. Validate and submit:
   ```
   winget validate winget/
   # then open a PR to microsoft/winget-pkgs under
   # manifests/o/oniolivvs/MusicPlayer/<version>/
   ```
