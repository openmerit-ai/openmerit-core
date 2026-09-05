# OpenMerit landing page

Independent Next.js landing page for OpenMerit, built with the App Router and Tailwind CSS.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production

```bash
npm run build
npm start
```

The build produces a self-contained Next.js server in `.next/standalone`, including public and static assets. It can be deployed to any Node.js host. A multi-stage Dockerfile is included for container platforms.

```bash
docker build -t openmerit-site .
docker run --rm -p 3000:3000 openmerit-site
```

Set `PORT` and `HOSTNAME` through the host environment when needed. No ChatGPT Sites, Vinext, Wrangler, or Cloudflare runtime is required.
