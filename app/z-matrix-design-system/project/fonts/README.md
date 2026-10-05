# Fonts

Z-Matrix uses **three Google Fonts** families, loaded via CDN in `colors_and_type.css`:

| Family | Role | Weights used |
|---|---|---|
| **Plus Jakarta Sans** | Display / headings | 400, 500, 600, 700, 800 |
| **Inter** | Body / UI | 400, 500, 600, 700 |
| **JetBrains Mono** | Numerics / code / IDs | 400, 500, 600, 700 |
| Space Grotesk *(alt display)* | Marketing-only alt | 400, 500, 600, 700 |

All four are open-license (OFL/Apache) and served by `fonts.googleapis.com`. No local `.ttf` / `.woff2` files are bundled — production code should swap in self-hosted copies (download from [fonts.google.com](https://fonts.google.com)) for offline builds and to remove the runtime dependency on Google Fonts.

⚠️ **Substitution note for the user**: the design brief did not include any custom or licensed font files. Plus Jakarta Sans + JetBrains Mono + Inter are *exactly* what the existing Matrix renderer uses (`tailwind.config.js` / `globals.css`), so this is a faithful match — not a downgrade — but please flag if a licensed display face is intended for the wordmark.
