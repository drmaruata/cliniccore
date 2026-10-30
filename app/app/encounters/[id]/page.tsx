import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getEncounter } from "@/lib/clinical/queries";
import { EncounterEditor } from "./encounter-editor";

export const metadata: Metadata = {
  title: "Encounter",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EncounterPage({ params }: PageProps) {
  const { id } = await params;
  const encounter = await getEncounter(id);

  if (!encounter) {
    notFound();
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-4xl">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-2xl font-bold">Clinical Encounter</h1>
        <span className="px-2 py-1 text-xs font-medium rounded-full bg-muted">
          {encounter.encounter.status}
        </span>
      </div>

      <EncounterEditor encounter={encounter} />
    </div>
  );
}
