import { LibraryView } from "@/components/LibraryView";
import { listRegistry } from "@/lib/registry";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tier = typeof params.tier === "string" ? params.tier : undefined;
  const q = typeof params.q === "string" ? params.q : undefined;
  const entries = await listRegistry({ tier, q });
  return <LibraryView activeTier={tier} entries={entries} query={q} />;
}
