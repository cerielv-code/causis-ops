# causis-ops

Private control panel for Causis Research and Anna.

- `web/index.html` is the whole panel (static, deployed by Netlify from this folder).
- `supabase/functions/jobs` is the background job function (email sync, email send, X metrics), running on the Supabase project `control-panel`.

Data lives in Supabase and is only readable by addresses in the `operators` table.
