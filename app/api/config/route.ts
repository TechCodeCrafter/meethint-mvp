import { PROVIDERS, type ProviderId } from "@/lib/providers";
export const dynamic = "force-dynamic";
export async function GET() {
  const server = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => !!process.env[PROVIDERS[p].env]);
  return Response.json({ server });
}
