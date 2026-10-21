# Gamekins website

Static launch website. HTML, CSS, and a small JavaScript module; no additional dependencies or package installation.

From the repository root, run `pnpm dev:site` and open the printed localhost URL. App previews come from the existing repository screenshots and are explicitly labeled illustrative. Download CTAs point to release updates until public binaries exist. Update availability copy when releases are actually public.

Deploy `website/` as a static Vercel project with no framework, build command, or install command. Keep this separate from the Electron desktop build. The included `vercel.json` adds security headers. No analytics, forms, remote fonts, or account credentials are required.
