# Render Deployment

Render gives the scanner a real HTTPS URL, which lets phone browsers use live camera access.

## Render Settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

## Environment Variables

Set these in Render before using the queue:

- `SCAN_TOKEN`: any long random value for phone scanner URLs
- `ADMIN_TOKEN`: any long random value for the counter/admin URL
- `PUBLIC_BASE_URL`: your Render service URL, for example `https://your-service.onrender.com`

Optional but recommended if the queue must survive restarts:

- `QUEUE_DATA_DIR`: a persistent disk path, for example `/var/data`

Without a persistent disk or database, Render can lose `queue-data/queue.json` when the service restarts or redeploys.

## URLs

- Scanner: `https://your-service.onrender.com/scanner?scanToken=SCAN_TOKEN`
- Counter: `https://your-service.onrender.com/counter?adminToken=ADMIN_TOKEN`
