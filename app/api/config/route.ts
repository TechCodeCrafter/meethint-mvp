import { PROVIDERS, type ProviderId } from "@/lib/providers";
export const dynamic = "force-dynamic";
export async function GET() {
  const server = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => !!process.env[PROVIDERS[p].env]);
  const stt = ["openai", "groq"].filter((p) => !!process.env[p === "openai" ? "OPENAI_API_KEY" : "GROQ_API_KEY"]);
  return Response.json({ server, stt });
}
