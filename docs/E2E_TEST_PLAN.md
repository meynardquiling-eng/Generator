# Live end-to-end check (Google side)

The Node tests (`npm test`) cover the workflow with fakes. These steps exercise the real Google
Forms, Sheets and Drive pieces, which can only run in a trainer's Google account after the Form
Bridge is installed.

Use two test Google accounts as "trainees" (A and B). Do not use real trainee data.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Settings: paste the bridge folder ID. Sources: request export, wait for the bridge run (≤5 min), import. | Section count shown; search finds "ETF" and "free month" sections. |
| 2 | Today → Start today's drill. | `APPROVE-DENY-<date>-001`, 5 scenarios `AD-001…AD-005`, status Trainer review. |
| 3 | Edit AD-002's ticket; regenerate AD-004; remove AD-005, then generate one more. | AD-002 v2 with the edit; AD-004 v2 with a new ticket; new scenario is AD-006 (AD-005 not reused). |
| 4 | Check every scenario has a verified source quote, or resolve its flag with a note. Approve. | Approve succeeds only when no blocking flags remain. |
| 5 | Create Google Form. Click it again. | Status Form requested. Only one `drillform-request__…` file in the folder. |
| 6 | Wait for the bridge, then Check form status. | Form created; trainee link, editor link and response sheet shown. |
| 7 | Open the trainee link signed out. | Google sign-in required. |
| 8 | Open the form as trainee A. | Drill instructions, sections per scenario with ticket and account details, tagged questions. No answer key, rationale, sources, coaching notes or scoring. No "see summary" link. |
| 9 | Run `runBridge` manually twice in Apps Script. | Still one form for the drill (check Drive and the result file). |
| 10 | Submit as A (mix of right and wrong). Submit as B. | Both appear in the linked response sheet. |
| 11 | Wait for the bridge, then Sync responses. Sync again. | 2 submissions, 2 trainees; second sync shows 0 new, 0 updated. |
| 12 | Responses tab. | Each answer shows the trainee answer next to the expected answer, rationale and source; action questions auto-scored; written answers "needs score". |
| 13 | Score a written answer, override an auto score, add gap tags and a note. | Final score stored next to the unchanged auto score. |
| 14 | Correct one answer key in the scenario editor. | Trainee content is locked; auto scores for that question change; reviewed scores flagged "recheck". |
| 15 | Accept remaining auto scores, complete the drill. | Status Completed; Coaching shows both trainees, gaps and common wrong answers. |
| 16 | Rename a question in the Forms editor, submit as a third account, sync. | Still maps (item ID). |
| 17 | Trash the drill's form in Drive and resend the request from a new drill copy. | Bridge creates a form only for the new drill ID; the old drill's result is unchanged. |
| 18 | Triage: propose catalog entries, approve two or more, create a Triage drill, generate. | Choices for process/tag/checklist come only from approved entries. |
