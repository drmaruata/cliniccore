"use client";

import type { FormEvent } from "react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Save, FileText } from "lucide-react";
import {
  finalizeEncounterAction,
  addEncounterAddendumAction,
  saveEncounterDraftAction,
} from "./actions";

interface EncounterDraft {
  chief_complaint: string;
  history: string;
  examination: string;
  assessment: string;
  plan: string;
}

interface EncounterWithDetails {
  encounter: {
    id: string;
    status: string;
    chief_complaint: string | null;
    history: string | null;
    examination: string | null;
    assessment: string | null;
    plan: string | null;
    finalized_at: string | null;
    finalized_by: string | null;
    started_at: string;
    updated_at: string;
    clinician_user_id: string | null;
  };
  patient: { first_name: string | null; last_name: string | null; mrn: string } | null;
  addenda: (EncounterAddendum & { author_name: string | null })[];
}

interface EncounterAddendum {
  id: string;
  body: string;
  created_at: string;
  author_user_id: string | null;
  encounter_id: string;
  organization_id: string;
}

interface EncounterEditorProps {
  encounter: EncounterWithDetails;
  onUpdate?: (encounter: EncounterWithDetails) => void;
}

const MAX_CHARS = 8000;

function charCount(value: string): string {
  return `${value.length}/${MAX_CHARS}`;
}

function isDraft(status: string): boolean {
  return status === "draft";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatAuthor(authorName: string | null): string {
  return authorName || "Unknown author";
}

export function EncounterEditor({ encounter, onUpdate }: EncounterEditorProps) {
  const { encounter: e } = encounter;
  const isDraftEncounter = isDraft(e.status);
  const [pending] = useTransition();

  const [draft, setDraft] = useState<EncounterDraft>({
    chief_complaint: e.chief_complaint ?? "",
    history: e.history ?? "",
    examination: e.examination ?? "",
    assessment: e.assessment ?? "",
    plan: e.plan ?? "",
  });

  const [addendumBody, setAddendumBody] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const handleDraftChange = (field: keyof EncounterDraft, value: string) => {
    if (value.length > MAX_CHARS) return;
    setDraft((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: "" }));
  };

  const handleAddendumChange = (value: string) => {
    if (value.length > MAX_CHARS) return;
    setAddendumBody(value);
    if (errors.addendum) setErrors((prev) => ({ ...prev, addendum: "" }));
  };

  const handleSaveDraft = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setGeneralError(null);

    const result = await saveEncounterDraftAction(e.id, draft);
    if (!result.success) {
      setGeneralError(result.error ?? "Failed to save draft");
      return;
    }

    const updated = {
      ...encounter,
      encounter: { ...e, ...draft, updated_at: new Date().toISOString() },
    };
    onUpdate?.(updated);
  };

  const handleFinalize = async () => {
    setGeneralError(null);
    const result = await finalizeEncounterAction(e.id);
    if (!result.success) {
      setGeneralError(result.error ?? "Failed to finalize");
      return;
    }
    onUpdate?.({
      ...encounter,
      encounter: { ...e, status: "finalized", finalized_at: new Date().toISOString() },
    });
  };

  const handleAddAddendum = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setGeneralError(null);

    if (!addendumBody.trim()) {
      setErrors((prev) => ({ ...prev, addendum: "Addendum body is required" }));
      return;
    }

    const result = await addEncounterAddendumAction(e.id, addendumBody);
    if (!result.success) {
      setGeneralError(result.error ?? "Failed to add addendum");
      return;
    }

    setAddendumBody("");
    onUpdate?.(encounter);
  };

  const sectionFields: { label: string; field: keyof EncounterDraft; placeholder: string }[] = [
    {
      label: "Chief Complaint",
      field: "chief_complaint",
      placeholder: "Primary reason for visit...",
    },
    {
      label: "History",
      field: "history",
      placeholder: "History of present illness, past medical history...",
    },
    { label: "Examination", field: "examination", placeholder: "Physical examination findings..." },
    {
      label: "Assessment",
      field: "assessment",
      placeholder: "Clinical impression / differential diagnosis...",
    },
    { label: "Plan", field: "plan", placeholder: "Management plan, orders, follow-up..." },
  ];

  return (
    <div className="space-y-6">
      {/* Patient header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {encounter.patient
              ? `${encounter.patient.first_name} ${encounter.patient.last_name} (${encounter.patient.mrn})`
              : "Unknown patient"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Encounter ID: {e.id} | Started: {formatDate(e.started_at)} | Updated:{" "}
            {formatDate(e.updated_at)}
          </p>
          <p className="text-sm text-muted-foreground">
            Status:{" "}
            <strong className={`ml-1 ${isDraftEncounter ? "text-brand-primary" : "text-success"}`}>
              {e.status}
            </strong>
            {e.finalized_at && (
              <span className="ml-2">Finalized: {formatDate(e.finalized_at)}</span>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Draft editor - only for draft encounters */}
      {isDraftEncounter && (
        <Card>
          <form onSubmit={handleSaveDraft}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">Draft Encounter</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {generalError && (
                <Alert variant="destructive">
                  <AlertDescription>{generalError}</AlertDescription>
                </Alert>
              )}

              {sectionFields.map(({ label, field, placeholder }) => (
                <div key={field} className="space-y-1">
                  <Label htmlFor={field}>{label}</Label>
                  <Textarea
                    id={field}
                    value={draft[field]}
                    onChange={(ev) => handleDraftChange(field, ev.target.value)}
                    placeholder={placeholder}
                    rows={4}
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground text-right">
                    {charCount(draft[field])}
                    {errors[field] && (
                      <span className="ml-2 text-destructive">{errors[field]}</span>
                    )}
                  </p>
                </div>
              ))}

              <Separator />

              <div className="flex gap-3 justify-end">
                <Button type="submit" disabled={pending}>
                  <Save className="mr-2 h-4 w-4" />
                  {pending ? "Saving..." : "Save Draft"}
                </Button>
                <Button type="button" variant="default" onClick={handleFinalize} disabled={pending}>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Finalize Encounter
                </Button>
              </div>
            </CardContent>
          </form>
        </Card>
      )}

      {/* Finalized view - read-only */}
      {!isDraftEncounter && (
        <Card>
          <CardHeader>
            <CardTitle>Finalized Encounter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-4">
              {sectionFields.map(({ label, field }) => (
                <div key={field} className="space-y-1">
                  <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
                  <dd className="whitespace-pre-wrap text-sm">{draft[field] || "—"}</dd>
                </div>
              ))}
            </dl>
            <Separator />
            <p className="text-sm text-muted-foreground">
              Finalized {e.finalized_at ? formatDate(e.finalized_at) : ""}
              {e.finalized_by && <span className="ml-2">by {e.finalized_by}</span>}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Addenda section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Addenda</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {encounter.addenda.length === 0 ? (
            <p className="text-sm text-muted-foreground">No addenda yet.</p>
          ) : (
            <dl className="space-y-4">
              {encounter.addenda.map((addendum) => (
                <div key={addendum.id} className="border-l-2 border-muted pl-4">
                  <dt className="text-sm font-medium flex items-center gap-2">
                    {formatAuthor(addendum.author_name)}
                    <span className="text-muted-foreground text-xs">
                      {formatDate(addendum.created_at)}
                    </span>
                  </dt>
                  <dd className="whitespace-pre-wrap text-sm mt-1">{addendum.body}</dd>
                </div>
              ))}
            </dl>
          )}

          {isDraftEncounter ? (
            <p className="text-xs text-muted-foreground">
              Addenda can only be added to finalized encounters.
            </p>
          ) : (
            <form onSubmit={handleAddAddendum}>
              <div className="space-y-2">
                <Label htmlFor="addendum">Add Addendum</Label>
                <Textarea
                  id="addendum"
                  value={addendumBody}
                  onChange={(ev) => handleAddendumChange(ev.target.value)}
                  placeholder="Additional notes, corrections, or updates to the finalized record..."
                  rows={3}
                  disabled={pending}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {charCount(addendumBody)}
                  {errors.addendum && (
                    <span className="ml-2 text-destructive">{errors.addendum}</span>
                  )}
                </p>
                <div className="flex justify-end">
                  <Button type="submit" disabled={pending || !addendumBody.trim()}>
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Addendum"}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
