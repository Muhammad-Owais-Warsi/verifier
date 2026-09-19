# Setup

## document-review

# Implementation Task

Implement the document review pipeline for a multi-tenant SaaS product.

Tenants upload documents. Each upload runs through the following process:

1. Extract the text of the uploaded file.
2. Split the extracted text into sections.
3. Summarise each section with an LLM.
4. Score each summary for confidence.
5. Any summary scoring below the confidence threshold is escalated to a human
   reviewer, who either approves it or edits it.
6. Once every section is settled, assemble and publish the final report.

## Requirements

### Tenancy and fairness

- One tenant uploading 500 documents must not delay documents belonging to other
  tenants.
- Tenants on the paid plan must be worked on ahead of tenants on the free plan
  when both are waiting.
- Concurrent pipelines must not share or overwrite each other's state.

### Human review

- A reviewer may respond in minutes, or take several days.
- While waiting for a reviewer, the pipeline must not hold on to compute or
  occupy capacity that other work could be using.
- The pipeline must survive deployments and worker restarts that happen during
  the wait.
- Reviewers respond through a separate HTTP endpoint in the app. The pipeline
  must not be what goes looking for their answer.
- If no reviewer responds within three days, the section is published with a
  generated disclaimer instead.

### Live output

- Summary text must appear in the reviewer's browser progressively as the LLM
  produces it, not only once the section is finished.
- A reviewer who reloads the page or connects late must still be able to follow
  the current state.
- Do not stand up a separate socket server, channel, or polling endpoint to
  carry this.

### Scale and cost

- Extracted text is routinely 20-50 MB. It must not be carried between stages as
  part of what each stage is handed.
- Text extraction is memory-hungry and occasionally exhausts the memory
  available to it. Give it more headroom, and recover when it still happens.
- Summarisation calls a rate-limited third-party API.
- A document may yield anywhere from 3 to 800 sections.

### Correctness

- Restarting or retrying the pipeline must not re-summarise sections that are
  already summarised, and must not double-charge the third-party API.
- Cancelling a pipeline must stop in-flight LLM requests, not merely mark the
  pipeline as cancelled.
- One section failing permanently must not stop the other sections from being
  published.
- The final report must not be assembled until every section is approved,
  edited, or disclaimed.
- Each summary must stay associated with the section it came from.

### Per-tenant scheduling

- Each tenant configures their own digest time and timezone, and can change it
  at any point.
- Tenants are added and removed continuously. A new tenant's digest must begin
  without a redeploy.

## Constraints

- Do not add an external workflow engine, job queue, or message broker.
- Do not implement your own retry, queueing, scheduling, or workflow state
  machine where the platform already provides one.
- Choose the platform primitives that fit each requirement.

## Consider the following edge cases

- A reviewer approves one section at the same moment another section fails.
- The worker running the pipeline is redeployed while 200 sections are
  mid-summary.
- Two tenants upload the same document at the same time.
- A reviewer responds twice for the same section.
- A reviewer responds after the three-day fallback has already fired.
- The third-party API returns 429s for several minutes.
- A tenant is deleted while their pipeline is still running.
- A document yields 800 sections, 40 of which need review.
- The reviewer's browser disconnects mid-stream and reconnects later.

Inspect the existing architecture before implementing, and do not rewrite
unrelated parts of the app.

## evidence-ingest

# Implementation Task

Implement the evidence ingestion pipeline for a legal e-discovery product.

A law firm (the tenant) opens a matter and uploads a corpus of scanned
documents. Uploading a corpus kicks off one ingestion, which does the following
for every document in it:

1. Read the scanned file from object storage.
2. Run OCR over it to recover the text.
3. Classify the text (contract, correspondence, invoice, filing, other).
4. Extract the named parties and dated obligations.
5. Write the extracted text and the structured result back to object storage.
6. Record the per-document outcome so the matter's review queue can be built.

When every document in the corpus has reached a terminal outcome, produce the
matter's ingestion manifest: which documents were ingested, which failed and
why, and where each result was written.

## Scale

These are the numbers the system is contracted to handle. They are not
hypothetical and the design has to hold at them.

- A corpus holds up to 5,000 documents. Large matters really do arrive as one
  upload of that size.
- A scanned document is between 2 MB and 40 MB. The recovered text of a long
  filing can itself reach 30 MB.
- A corpus is ingested once, but an operator may re-run the ingestion of a
  matter from the beginning after a misconfiguration is fixed.
- The firm's case managers watch a progress view while a corpus ingests, and
  they expect it to be accurate for corpora of every size.

## Requirements

### Throughput and fairness

- The OCR engine is licensed for 12 simultaneous jobs. Exceeding that gets the
  firm's licence suspended, so 12 is a hard ceiling on OCR work in flight at
  any moment, however many ingestions are running.
- One firm uploading a 5,000-document corpus must not hold up the corpora of
  other firms. Corpora arrive throughout the day and a large one must not mean
  every other firm waits for it to drain.
- Matters flagged as court-deadline-bound must be worked ahead of routine
  matters whenever both are waiting for OCR capacity.
- Two ingestions running at the same time must not read or overwrite each
  other's state.

### Resources

- OCR on a long scanned document is memory-hungry, and on the largest documents
  it exhausts the memory available to it outright. Give it the headroom it
  needs, and make sure a document that still exhausts it can go on to succeed
  rather than failing permanently.
- Documents and their recovered text live in object storage. Moving a document
  body through the pipeline itself, rather than referring to where it lives, is
  not acceptable at these sizes.

### Error handling

- The OCR engine reports two kinds of problem, and they must be treated
  differently. A transient fault — engine busy, rate limited, socket reset,
  object store unavailable — must be tried again. A permanent rejection —
  corrupt scan, password-protected file, unsupported format, page count over
  the engine's maximum — must not be tried again, because it will fail
  identically every time and each attempt is billed.
- The decision between the two has to be made from the error the engine raised,
  at the point it is raised.
- Transient faults must back off between attempts rather than retrying
  immediately, since the usual cause is the engine being saturated.

### Audit

- Compliance requires an audit trail of OCR activity on a matter. It must
  record every occasion on which OCR began work on a document, including each
  fresh attempt after a failure, and how many attempts a document took before
  it settled.
- The audit trail must reflect what actually happened to the run, not what the
  pipeline intended to do.

### Progress and live output

- The case manager's progress view must be accurate throughout an ingestion of
  any size in the supported range, and must stay accurate to the end. A
  progress view that works for a 50-document corpus and breaks the pipeline on
  a 5,000-document one is a defect, not a limitation.
- At each stage transition the progress record is rewritten in full rather than
  patched field by field, so a half-updated record is never visible.
- When a case manager opens a single document, the recovered text must appear
  in their pane progressively as the OCR engine emits it, not only once the
  whole document is finished.
- A case manager who opens the progress view late, or reloads it, must see the
  current state.

### Correctness

- Re-running a matter's ingestion must not OCR, re-bill, or rewrite documents
  that already completed successfully on an earlier run. This applies to a
  genuine re-run started later by an operator, not only to an automatic retry
  of a failure.
- One document failing permanently must not stop the rest of the corpus from
  being ingested, and must be reported as that document's outcome.
- The manifest must not be produced until every document has reached a terminal
  outcome.
- Cancelling an ingestion must stop the OCR and extraction work that is in
  flight, not merely mark the ingestion as cancelled.
- The pipeline must survive deployments and worker restarts mid-ingestion.
- Every result must stay associated with the document it came from.

## Consider the following edge cases

- A corpus of 5,000 documents is uploaded as a single ingestion.
- A 40 MB scan whose recovered text is larger than the scan.
- OCR exhausts its memory on document 3,100 of 5,000.
- An operator re-runs a matter that previously completed 4,200 of 5,000
  documents.
- The worker is redeployed while 400 documents are mid-OCR.
- The OCR engine returns rate-limit responses for several minutes.
- A password-protected PDF sits at position 12 of a 5,000-document corpus.
- Two firms upload same-sized corpora within a second of each other.
- A case manager opens the progress view when the ingestion is 90% done.
- The manifest is requested for a corpus in which 12 documents failed.
- A matter is deleted while its ingestion is still running.

## Scope

The OCR engine, the object store and the app's own database are external to
this work: call them, but do not implement them. Stub them behind a small
module boundary if you need to.

Use the current major version of each dependency you add, and its current
APIs.
