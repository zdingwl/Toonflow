# MiniMax H3 Ref2VA Prompt Skill · Toonflow

Transform one storyboard segment and its actual uploaded image slots into the official MiniMax H3 six-section prompt. Return ONLY these six sections, exactly once, in this order: `subject_definitions:`, `summary:`, `retention_analysis:`, `detailed_description:`, `overall_soundscape:`, `non_diegetic_music:`. All instruction prose must be English. Only original dialogue, lyrics and deliberately visible scene text retain their original language. Do not write Markdown notes or explanations.

## Inputs and reference-binding contract

Inputs may include `target_duration` (seconds), `referenceSlots` (the actual ordered images uploaded to Ref2VA), `assetDefinitions` (parent identity, current state, source scene, asset names and visual facts), `storyboardGuidance` (TEXT-ONLY visual guidance, not an uploaded image), and `storyboardItem` (shot actions, dialogue, camera, audio, time budget).

`referenceSlots` is authoritative: its ordered item 1 is `<Picture 1>`, item 2 is `<Picture 2>`, etc. Preserve the exact order; do not sort references in prose, invent a number, refer to a missing file or count storyboardGuidance as a Picture. A role may occupy TWO consecutive slots: FACE and FULL_BODY_FRONT. They define **one reusable Subject**, never two separately appearing characters. Create one Subject for each distinct visible role, environment, prop or creature. Each Subject cites only its actual Picture source(s).

Before output, reconcile asset name + parent identity + current state + role (FACE/FULL_BODY_FRONT) against each actual slot. If a slot is missing, contradicts the active scene state, belongs to a different character, or if there are insufficient slots for the requested subjects, do NOT fabricate Picture links, silently substitute the base form, or include both mutually exclusive forms in one shot. Report a reference/state binding failure to the calling process instead of producing a seemingly valid prompt. A transformation within the shot has a clear BEFORE → AFTER boundary and only the intended state is visible after that boundary; it is not two characters.

Storyboard images inform camera staging only; they are not identity authority. The current asset reference is the identity and wardrobe source. Prioritize named, observable visual anchors over vague tags such as 'high quality, cool, epic'. If the project's visual style is cinematic stylized 3D animation, express CG rendering, PBR materials, controlled facial stylization and lighting, NOT live-action photographs.

## Official Subject vs Picture semantics

Use `<Subject N>` for reusable visible subjects. An uploaded image defining the subject is cited inside its definition, e.g. `<Subject 1> is the same character shown in <Picture 1> (face) and <Picture 2> (front full body), with the current-state hairstyle, facial structure, outfit seams and proportions preserved.` Reference to the Picture itself as a standalone defined object is reserved for an actual first frame/keyframe/last frame/composition anchor. Do not assign one Subject to face and another to the same character's full-body image.

## Required output

`subject_definitions:`: Define each Subject once with positive and observable appearance facts. Separate stable identity attributes from explicitly changed current-state attributes. Specify environment topology and prop geometry where relevant. No guessed age, height or accessories.

`summary:`: Start with `[reference generation]` for image-reference execution; one concise paragraph covering the subject(s), scene action, and shot flow. No new Subject or Picture labels.

`retention_analysis:`: One line per reference item, using ONLY `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`. State exactly what is retained and what visibly changes. A current-state reference must not be partially overwritten with the incompatible parent-form look.

`detailed_description:`: Begin with one or two sentences of the target observable render style, current environment, lighting and composition. Then `[Shot 1]` (no timestamp) and optional further `[Shot N] At 00:SS.mmm, ...` with strictly increasing timestamps inside target_duration. Each shot gives visible Subject placement, action and movement progression, camera path, diegetic sound, and changes that can actually complete in the available seconds.

Time and action budget (default, not a mandatory cut count):
- 0–5 s: one principal action, usually one shot; a second shot only if essential and feasible.
- >5–10 s: one or two principal actions and at most about three distinct shots unless the storyboard explicitly and feasibly demands more.
- >10–15 s: two or three principal actions, transitions only where the script requires them.
- Preserve exact script dialogue/VO; estimate speech time FIRST. If dialogue, indispensable actions and transitions cannot fit in target_duration, report that the storyboard must be rescheduled or split; do not accelerate speech unrealistically or silently omit lines.
- A state-changing action has clear time-localized phases (before → observable onset → resulting appearance); do not repeat the whole transformation in every segment or show both forms at the same time.
- Do not ask the model to achieve excessive independent camera movements, poses, facial changes and large effects in one tiny segment. Use one clear camera path per shot.

`overall_soundscape:`: Brief English summary of ambience, action effects and non-verbal vocalizations; do not duplicate dialogue or add new music.

`non_diegetic_music:`: `N/A` unless the script explicitly requires audience-only background score; if explicitly requested, describe instrumentation, tempo and dynamic change in English.

## Dialogue

Assign `(S1)`, `(S2)`, ... in first spoken order and keep each ID stable. Referenced speaking characters use both Subject and speaker ID, e.g. `<Subject 1> (S1) says, <d>[Chinese] 原始中文台词。</d>`; performative direction and mouth movement are outside `<d>`. Keep exact original dialogue, never invent or repeat full dialogue in the soundscape.

## Final hard checks

Six sections exactly once and ordered; actual Picture indices only; one reusable Subject per character; FACE and FULL_BODY_FRONT refer to the SAME identity and current state; no storyboard picture; no incompatible parent/derived form in the same shot; only approved relationship markers; Shot 1 untimed; later times strictly increasing within target_duration; speech is feasible; original dialogue intact with stable speaker IDs; camera and actions feasible for the duration; music N/A unless explicitly requested. Positive, actionable details are preferred over long exclusion lists.
