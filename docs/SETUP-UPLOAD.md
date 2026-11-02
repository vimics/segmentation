# Connecting V-Seg to SharePoint

For the Vimics Microsoft 365 administrator and whoever deploys the upload service. Allow about 30 minutes.

This is the detail behind Part 2 of [GO-LIVE.md](GO-LIVE.md). The viewer is a public web page, so it can't hold SharePoint credentials. A small Cloudflare Worker holds them, checks each case, and gives the browser a one-time upload link. Vets never sign in.

## 1. Create a dedicated SharePoint site

Create a new private SharePoint site, for example **V-Seg Data**, and give access only to the people who will work with the data. Don't reuse an existing site or a personal OneDrive: the app in step 2 gets write access to this site only.

In the SharePoint admin centre, set a **storage limit** on this site. Upload links can't enforce a file size, so this limit is what stops anyone filling your company's storage.

## 2. Register the app in Microsoft Entra ID

An administrator does this in the [Entra admin centre](https://entra.microsoft.com).

1. Go to **App registrations**, choose **New registration**, name it `Vimics V-Seg Upload`, and register it as single tenant with no redirect URI.
2. Note the **Application (client) ID** and **Directory (tenant) ID**.
3. Under **Certificates & secrets**, create a client secret and copy its value. It's shown only once. Put a reminder in your calendar for its expiry date, because uploads stop when it expires.
4. Under **API permissions**, add **Microsoft Graph**, then **Application permissions**, then `Sites.Selected`. Choose **Grant admin consent**.

`Sites.Selected` gives the app no access until it's granted a specific site in the next step.

## 3. Give the app access to that one site, and find the drive ID

In [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer), signed in with `Sites.FullControl.All`. Microsoft requires this person to hold an administrator role such as SharePoint Administrator **and** to be a member of the V-Seg Data site, so add them to the site first.

```http
GET https://graph.microsoft.com/v1.0/sites/{tenant}.sharepoint.com:/sites/VSegData
```

Note the `id` from the response, then:

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions

{
  "roles": ["write"],
  "grantedToIdentities": [
    { "application": { "id": "{client-id}", "displayName": "Vimics V-Seg Upload" } }
  ]
}
```

```http
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drive
```

The `id` from this last response is the **drive ID**.

If step 6 later fails with a 403 from Microsoft, the upload endpoint may need `Sites.ReadWrite.All` in your tenant: Microsoft's page for this call lists that permission and doesn't list `Sites.Selected`. It covers every site in the company, so first check `Sites.Selected` was granted correctly, and treat the wider access as a decision for your administrator.

## 4. Deploy the Worker

Create a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, then from the `worker` folder:

```sh
npx wrangler login
npx wrangler secret put TENANT_ID
npx wrangler secret put CLIENT_ID
npx wrangler secret put CLIENT_SECRET
npx wrangler secret put DRIVE_ID
npx wrangler secret put ACCESS_CODE
npx wrangler deploy
```

Choose any long random text for `ACCESS_CODE`. While it's set, only people with that code can store anything. Wrangler prints the Worker's address, ending in `workers.dev`.

`ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the sites allowed to send cases. `https://vimics.vet` is already included. If you change this file, run `npx wrangler deploy` again.

## 5. Tell the viewer where the Worker is

In the GitHub repository, go to **Settings**, **Secrets and variables**, **Actions**, **Variables**, and add `VITE_UPLOAD_URL` with the Worker's address. Then re-run the **Deploy** workflow.

Until this is set, the viewer works normally and the sidebar says storage isn't connected.

## 6. Test

Open the site with the code in the address:

```
https://vimics.vet/segmentation/?code=YOUR_ACCESS_CODE
```

Load a case you're allowed to store. The sidebar should end with **Stored with Vimics** and a reference such as `VS-20261103-3FA91C07D2`.

Check SharePoint for `V-Seg/2026/11/<reference>/`, holding `case.json` and `series.zip`. Open one slice from the ZIP in a DICOM viewer and confirm that no owner or clinic details remain.

## 7. Direct upload or relay

The browser first uploads straight to SharePoint and, if the browser blocks that, sends chunks through the Worker instead. Both paths are tested against a simulation only, so step 6 is the first real test of which one your tenant uses. The relay works but sends every scan through Cloudflare, so tell your legal reviewer if that's the path in use.

## Before public launch

- [ ] Legal review of the consent wording, `privacy.html` and the footer under KVKK and GDPR, including whether consent may be a condition of using a free tool
- [ ] Decide how long data is kept, then state it in `privacy.html`
- [ ] Decide who handles deletion requests, which arrive at info@vimics.vet with a case reference
- [ ] Remove `ACCESS_CODE` with `npx wrangler secret delete ACCESS_CODE`
- [ ] Add bot protection: create a Cloudflare Turnstile widget, set the `TURNSTILE_SECRET` Worker secret and the `VITE_TURNSTILE_SITE_KEY` GitHub variable
- [ ] Add a Cloudflare rate limiting rule, since the Worker's built-in limit is per instance
- [ ] Check SharePoint storage quota against expected volume: the two largest real cases sent 193 and 304 MB
