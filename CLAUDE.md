# V-Seg Engine · vimics.vet/segmentation

A free browser tool from Vimics. A vet drops a CT scan and gets a 3D bone model to rotate, section and measure. With consent, a de-identified copy is stored to train a bone segmentation network. Not for surgical planning or 3D printing.

Umut and Onur build this by working with AI agents. Explain what you change in plain words.

## How the website fits together

| Address | Repository | Notes |
|---|---|---|
| vimics.vet | `vimics/vimics.github.io` | Main site, owned by Onur. Also holds `/dicom/` |
| vimics.vet/segmentation/ | `vimics/segmentation` (this repo) | V-Seg |

- Every push to `main` goes live. GitHub Actions runs `.github/workflows/deploy.yml`, which runs the unit tests, builds the site into `dist/` and publishes it. If the tests fail, the live site stays as it was.
- `dist/` is built, never committed. Keep paths relative, because the site runs from a subfolder.
- Never add a `CNAME` file here, and never create a `segmentation/` folder in the main site repo.
- Repository and Pages settings are changed by Onur only.

## Before every push: pull first

Umut and Onur both push to `main`, often at the same time.

1. At the start of a session, run `git fetch origin && git status -sb` and tell the person if they are behind or have uncommitted work.
2. Push finished work without asking. Before pushing, always:
   ```sh
   git pull --rebase origin main
   npm test && npm run build
   git push origin main
   ```
3. If the push is rejected, pull again with `--rebase`. Never use `--force`, and never change commits that are already pushed.
4. Work that takes more than a day goes on a branch, `umut/<topic>` or `onur/<topic>`, and joins `main` when finished.
5. After pushing, check the deploy with `gh run list --workflow Deploy --limit 1`, then open the live page.

## Commands

```sh
npm install           # once
npm run dev           # local preview
npm test              # unit tests
npm run test:e2e      # browser tests
npm run build         # type check and build
```

## Where things are

| Path | What |
|---|---|
| `index.html`, `privacy.html` | The two pages |
| `src/app` | Form, sidebar, upload client |
| `src/engine` | Reading CT files, building and showing the 3D model |
| `worker` | Upload service holding the storage credentials |
| `docs` | Go-live steps and what real cases taught us |

## Rules that must not break

- `test-data/` holds real scans with owner and clinic names. It stays out of git, and those names stay out of chat and tool output. Read it only through the `tools/` scripts, and run `tools/check-commit.run.ts` before pushing anything built from it.
- The repo is public: no passwords, keys or patient data, ever.
- De-identification is an allow-list, `KEEP` in `src/engine/dicom/deidentify.ts`. Never add a free-text field.
- The consent wording, `privacy.html` and what the code sends must match.
- Keep `<meta name="robots" content="noindex">` until Umut and Onur launch.
- Page text: no CE or FDA claims, no "best", "leading", "only" or "first", no guarantees, exclamation marks, emoji, prices or phone numbers.
- Decided, so don't change these unless asked:
  - **Series:** the most slices wins.
  - **Threshold:** opens at 300 to 1900 HU.
  - **Filters:** small shells and thin fragments are both on by default.
  - **Axes:** only X, Y and Z, with no left or right labels.
  - Every decision is a fixed rule on the file's data, never a judgement made at runtime.
- Not yet proven: the real SharePoint connection, clinic laptops and legal review. Don't describe them as done.
- Reply in the language the person writes in.
