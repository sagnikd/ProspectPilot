# ProspectPilot

A React and Express cold outreach engine for finding local US businesses, extracting contact emails, auditing websites from screenshots, and drafting personalized outreach.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Add these keys to `.env`:

```bash
GEOAPIFY_API_KEY=your_geoapify_key
GEMINI_API_KEY=your_gemini_key
```

The app runs at `http://localhost:5173`.

## Scripts

```bash
npm run dev      # Express API with Vite middleware
npm run build    # Production client build
npm run start    # Serve the built app with Express
```

## Notes

- Geoapify geocodes the selected city and state, then searches by `place_id` with a 15km circle fallback.
- Contact extraction checks priority pages before the homepage and keeps going through 404s.
- Microlink screenshots feed the Gemini Vision audit prompt.
- The Express app exports a `serverless-http` handler and only calls `app.listen` outside serverless environments.
