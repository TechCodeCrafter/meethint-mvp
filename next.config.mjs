// Content-Security-Policy: the page may only open network connections to itself, the four AI
// providers and GitHub. Your API key is used browser → provider directly; this policy makes it
// impossible for the page to send it anywhere else.
const CONNECT = [
  "'self'",
  "https://api.openai.com",
  "https://api.anthropic.com",
  "https://api.x.ai",
  "https://api.groq.com",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
  "blob:",
  "data:",
];
const CSP = [
  `connect-src ${CONNECT.join(" ")}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self), display-capture=(self)" },
        ],
      },
    ];
  },
};
