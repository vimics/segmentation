# Putting V-Seg on vimics.vet and connecting SharePoint

For Umut and Onur. Follow it top to bottom. Each step says who does it and how to check it worked.

## The short version

1. **The website is already on GitHub.** vimics.vet is served by GitHub Pages from the repository `vimics/vimics.github.io`, and the domain is registered through GoDaddy. So V-Seg can go on the same site without changing hosting.
2. **V-Seg needs no server.** It's a folder of static files. The 3D model is built on the vet's computer.
3. **SharePoint needs one small helper.** A public web page can't hold a SharePoint password, so a small Cloudflare service holds it and hands the browser a one-time upload link.
4. **Do it in this order:** put the tool online unlisted, connect SharePoint and test it with a private code, complete the legal review, then link it from the menu.

Umut can push to both repositories, but repository settings, such as Pages, need Onur.

## How it fits together

```
Vet's browser                                      Stays on the vet's computer:
 ├─ reads the CT, builds the 3D model              the original files
 ├─ removes names, zips the chosen series
 │
 ├─ 1. "Here's a case" ───────►  Cloudflare Worker (holds the SharePoint login)
 │                                ├─ checks the case
 │                                ├─ saves case.json ──────► SharePoint
 │    ◄── one-time upload link ───┘
 │
 └─ 2. Uploads series.zip in 5 MB pieces ──────────────────► SharePoint
```

What arrives in SharePoint, with no one at Vimics doing anything:

```
V-Seg/2026/11/VS-20261103-3FA91C07D2/
├── case.json     form details, consent record, scan facts
└── series.zip    the de-identified CT
```

| Piece | What it is | Who owns it |
|---|---|---|
| `vimics/vimics.github.io` | The website | Onur |
| `vimics/segmentation` | The tool | Onur, shared with Umut |
| Cloudflare Worker | The helper holding the SharePoint login | A Vimics Cloudflare account |
| SharePoint site | Where the scans are stored | The Vimics Microsoft 365 administrator |

---

## Part 1: Put the tool on the site

Result: the tool is live at `vimics.vet/segmentation/`, not linked from anywhere yet.

**Done on 2026-11-02:**

- The website repository is renamed to `vimics.github.io`. vimics.vet, its sitemap pages and `/dicom/` still work.
- V-Seg's code is in `vimics/segmentation`, and Umut can push to it and to the website repository.
- A private copy of the earlier repository is kept at `umuttutal/v-seg-legacy`.

**Left for Onur:** only he can change repository settings.

1. In `vimics/segmentation`, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Open **Actions → Deploy → Run workflow** on `main`.
3. **Check:** open `https://vimics.vet/segmentation/`, open a demo case and confirm it rotates.

From then on, every push to `main` tests and publishes the tool. Don't add a `CNAME` file to this repository: the address comes from the website's domain.

**Why it's set up this way:** GitHub serves other repositories under your domain only when the main site lives in a repository named `<account>.github.io`. With that name, V-Seg keeps its own repository and its own updates, and the website isn't touched.

---

## Part 2: Connect SharePoint

Result: cases stored automatically, available only to people with a private test code. Allow about an hour, once you have the right people. You need your **Microsoft 365 administrator**. If that isn't Onur, find out who it is first.

Full click-by-click commands are in [SETUP-UPLOAD.md](SETUP-UPLOAD.md). Here's what each step is for.

| Step | Who | What it does |
|---|---|---|
| 1. Create a SharePoint site, "V-Seg Data" | Admin | Separates scans from company files. Don't use the OneDrive folder `/dicom` links to today |
| 2. Set a storage limit on that site | Admin | Upload links can't enforce a size limit, so this is the backstop |
| 3. Register an app in Microsoft Entra | Admin | Gives the Worker its own identity. Set a calendar reminder for when the secret expires, because uploads stop that day |
| 4. Give the app access to that one site | Admin | The app can't touch anything else in the company |
| 5. Create a Cloudflare account and deploy the Worker | Onur or Umut | Puts the helper online. It needs a Cloudflare account, and the free plan should be enough to start |
| 6. Add `VITE_UPLOAD_URL` to the repository and redeploy | Onur or Umut | Tells the tool where the Worker is. Without it, nothing is sent |
| 7. Test with `?code=...` | Umut | The first real test. See below |

### The first real test

Open `https://vimics.vet/segmentation/?code=YOUR_CODE` and load a case you're allowed to store. Then check all of this:

- [ ] The sidebar ends with a reference like `VS-20261103-...`
- [ ] SharePoint shows `case.json` and `series.zip` in that folder
- [ ] `case.json` holds the form details, consent text and scan facts
- [ ] Unzip one slice and open it in a DICOM viewer: **no owner, clinic or original patient details**
- [ ] It opens in Mimics, which decides whether stored scans can be used for real cases
- [ ] Note in the browser's developer tools whether uploads go straight to `sharepoint.com` or through the Worker. If through the Worker, tell the legal reviewer, because every scan then passes through Cloudflare

**Most likely to go wrong:** a 403 error from Microsoft. Their documentation lists a broader permission for this upload call than the site-only one we use. If it happens, recheck Step 4 of the setup before accepting wider access, since the broader permission covers every site in the company.

### To turn storage off at any time

Delete `VITE_UPLOAD_URL` from the repository variables and re-run **Deploy**. The tool keeps working and sends nothing.

---

## Part 3: Before anyone outside can use it

None of this is technical, and some of it could stop the launch.

| Decision | Why | Who |
|---|---|---|
| **Legal review** of consent, `privacy.html` and the footer under KVKK and GDPR | The tool stores scans for AI training, and the consent box is required to use it | Lawyer |
| **Permission for the 4 demo cases** | They are real animals' scans, already public, and anyone can download them. Removing them later means rewriting Git history, and copies may already exist | Umut |
| **Is the footer's and sidebar's wording acceptable** | The sidebar promises a free segmentation engine "in training" | Umut |
| **How long data is kept** | `privacy.html` must state it, and it doesn't yet | Umut and lawyer |
| **Who handles deletion requests** | They arrive at info@vimics.vet with a case reference | Umut |

Then, technically:

- [ ] Add bot protection: Cloudflare Turnstile, using `TURNSTILE_SECRET` and `VITE_TURNSTILE_SITE_KEY`
- [ ] Add a Cloudflare rate limit rule, because the Worker's own limit is only per instance
- [ ] Delete the `ACCESS_CODE` secret
- [ ] Remove `https://umuttutal.github.io` from `ALLOWED_ORIGINS` in `worker/wrangler.toml`
- [ ] Try it once on a typical clinic laptop, and once each in Safari and on Windows

---

## Part 4: Make it feel like part of the site (Onur)

The tool already uses the site's fonts and colours, and its logo links home.

1. Add **Segmentation** to the site menu, linking to `/segmentation/`. Check whether pages are generated from the `_src` folder, and edit there if so.
2. Add `https://vimics.vet/segmentation/` to `sitemap.xml`.
3. On `/dicom/`, add a line such as "See it in 3D first", linking to `/segmentation/`.
4. Don't create a `segmentation` folder in the website repository, or it may conflict with the tool's address.

The tool's "Send a case" button already opens `/dicom/`.

---

## What's ready, and what isn't

**Checked and working:**

| Check | Result |
|---|---|
| All 4 real cases, exactly as received | Open with no cleanup, in 3 to 7 seconds on a Mac |
| Viewer ZIPs, BMP copies, programs, readmes, damaged ZIPs, corrupt slices | Handled, with a clear message or warning |
| De-identification on all 2,704 chosen real slices | No private tags, original IDs or name fields left |
| Upload path with a simulated SharePoint | Worked at 193 and 304 MB, including a dropped connection |
| Running from a subfolder, with no absolute paths | Works |
| Live site in Chrome's, Firefox's and Safari's engines | All 18 checks pass in each: demos, messy folders, JPEG 2000, rotation, sliders, filters |
| Phone and tablet layout | Nothing cut off |
| Automated tests | 164 unit and 49 browser tests pass |

**Not yet proven, and only you can do it:**

- The real SharePoint connection. It has only run against a simulation
- Real clinic laptops. Peak browser memory was about 2 to 2.5 GB on the two largest cases, which may be tight on 8 GB
- Real Safari and Windows. Automated checks used the engines those browsers are built on, not the browsers themselves
- Accuracy against Mimics: the default threshold and thin-fragment limit have not been compared with Mimics masks

**Known limits to accept or fix later:**

- Closing the tab during an upload loses that upload. The page warns first
- Lossy-compressed and enhanced multi-frame scans are refused, with a message saying so
- Upload links can't enforce a size. Bot protection, rate limits and the site's storage limit are the defence
- Treat stored files as untrusted, since anyone can reach the upload service once it's public
- GitHub Pages suggests staying under about 100 GB of traffic a month. Demo files average 57 MB, so that's roughly 1,750 demo opens a month. Vets' own scans don't count, because they never touch GitHub

## Cost

| Item | Expected cost |
|---|---|
| GitHub Pages, public repositories | Free |
| Cloudflare Worker | Free plan should be enough to start. Check their current limits |
| SharePoint | Part of your Microsoft 365 plan. Budget about 200 to 300 MB per case, so about 250 GB per 1,000 cases. Check your quota with the admin |

## Later, not needed for launch

- **Vaka Kaydı list in SharePoint**, one row per case. Today you get folders and `case.json`. The Worker can add the row
- **Moving `/dicom/` off the personal OneDrive folder** and onto the same storage
- **"Share this case" with no re-upload**, joining the two entry points under one CaseID
- **Anonymous upload stats** in `case.json`, to learn what forms vets send and which filter names go unrecognised
