# Screenshots for the Marketplace page

The Marketplace renders `README.md` from the repository and does not host
images itself, so every image needs an absolute URL. The README refers to the
files in this folder through raw.githubusercontent.com; they are therefore
served from the `main` branch and must be committed and pushed before the
Marketplace page can show them.

Expected files, referenced by the README in this order:

| File | Shows |
|---|---|
| `freq-scope.png` | the frequency scope with a tone and its readout |
| `spectrogram.png` | the spectrogram with labelled axes |
| `ats-browser.png` | an ATS analysis with its partials |
| `waveform.png` | a buffer waveform |
| `sample-browser.png` | the sample table |
| `midi-monitor.png` | the MIDI log with decoded messages |

A useful screenshot shows the view with real content and enough surrounding
editor to make clear where it sits. Crop to the panel plus its caption line;
the whole VS Code window at full resolution is unreadable at Marketplace
width, which is about 1000 pixels.

This folder is excluded from the VSIX by `.vscodeignore`: the images are
fetched from GitHub, and shipping them in the package would be dead weight.
