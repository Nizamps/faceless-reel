# Faceless Studio

Personal short-video studio: save a series style once, produce a new 50–59 second episode each day, review it in a private library, and download the finished MP4 for manual YouTube upload. There is no YouTube OAuth or auto-publishing.

## Deployment shape

- GitHub Pages serves the static app.
- Supabase Auth and Postgres keep your settings and episode status; Supabase Storage holds private MP4s.
- GitHub Actions runs the daily worker at **8:17 AM Asia/Kolkata**, leaving a long buffer before the 7 PM target. GitHub may delay scheduled runs, so 7 PM is a target rather than a guaranteed delivery time.
- Gemini generates the topic/script, narration, music, and 4K illustrated scene frames. FFmpeg animates and assembles the frames into a 4K MP4. You review and upload it yourself.

The browser contains only the Supabase publishable key. Keep the Gemini API key and Supabase service-role key in server-side secrets. The Gemini key previously pasted into chat should be revoked and replaced before enabling generation.

## One-time setup

1. Push this folder's contents to the `main` branch of `Nizamps/faceless-reel`.
2. In GitHub, open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
3. In Supabase **Authentication → URL Configuration**, add the deployed Pages URL (`https://nizamps.github.io/faceless-reel/`) to the allowed redirect URLs. Add `http://localhost:4173/` if you will also run it locally.
4. From this folder, install the Supabase CLI, then run `supabase login`, `supabase link --project-ref mivjedzcydxqisursdiq`, and `supabase db push`. The linked project's database password is requested by the CLI and should not be committed.
5. Deploy the interactive script function:

   ```sh
   supabase secrets set GEMINI_API_KEY=YOUR_REPLACEMENT_KEY
   supabase functions deploy generate-episode
   ```

6. In GitHub **Settings → Secrets and variables → Actions**, add these repository secrets:

   - `SUPABASE_URL`: your project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: the project's service-role/secret key. It must stay in Actions secrets; never use it in `supabase-config.js`.
   - `GEMINI_API_KEY`: a replacement Gemini key.

7. Sign in to the deployed app with the email magic link, set the one-time series options, and save them. Daily preparation is enabled by default. The schedule will run once the workflow exists on the default branch and all three GitHub secrets are set. Use **Actions → Prepare daily video → Run workflow** for a first manual run.

## Local preview

Use Node.js 20+ and run `npm start`, then open `http://127.0.0.1:4173`. This serves the static files; cloud sign-in and generation still require the Supabase migration, function, and secrets above.

## Notes

- The workflow uses an idempotent per-user/per-day episode record and a $30 monthly estimated-generation cap from the saved profile. A budget hold is recorded instead of starting a new render once the cap is reached.
- GitHub scheduled runs can be delayed, and scheduled workflows in public repositories can be disabled after 60 days without repository activity. Check the Actions tab if an episode is missing.
- 4K output is computationally expensive and large. The worker is capped at six hours per run and may fail if the selected models, quotas, billing, or Actions runner capacity are unavailable. Failed runs are recorded in the library and in Actions logs.
- Supabase Storage has a 512 MB object cap configured by the migration. Finished videos remain private and the app creates a one-hour signed download URL.
- Verify historical claims, captions, and the final edit before uploading.

## Database and media

SQL schema and RLS policies are in `supabase/migrations/`. The private Storage bucket is created by the migration. `scripts/daily-worker.mjs` is the scheduled renderer; `.github/workflows/pages.yml` deploys the site and `.github/workflows/daily-video.yml` runs the renderer.
