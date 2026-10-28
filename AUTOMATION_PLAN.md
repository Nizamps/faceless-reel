# Daily video workflow

The app keeps one saved creative profile in Supabase. When daily preparation is enabled, GitHub Actions starts the worker at 8:17 AM Asia/Kolkata. It checks the last 30 days of topics, asks Gemini for a researched topic and script, creates narration and instrumental music, generates six 4K illustrated scene frames, adds captions and motion/effects with FFmpeg, then uploads a private MP4 to Supabase Storage. The library shows status and a one-hour download link. YouTube upload remains manual.

The target is to have the file ready by 7 PM, with a 10-hour-43-minute buffer. GitHub notes scheduled jobs may be delayed, so this is not a delivery guarantee. The workflow permits up to six hours for a render. Check GitHub Actions and the episode status when a run fails.

## Estimated cost controls

The worker uses the saved per-user monthly budget (default $30) and estimates $0.95 for one production before starting. It records `budget_hold` when the remaining amount is below the estimate. This is a guardrail, not a billing limit: actual Google API charges can vary, and API billing/quotas are separate from a Gemini Pro subscription. Review the provider's current rates before enabling the schedule.

## Deployment dependencies

See `README.md` for the complete setup. In short: push to the default branch, deploy the Supabase migration and interactive function, allow the GitHub Pages sign-in redirect in Supabase Auth, add the three GitHub Actions secrets, save a series profile, then manually run the workflow once before relying on the daily schedule.
