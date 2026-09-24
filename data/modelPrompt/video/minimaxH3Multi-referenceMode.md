# MiniMax H3 Ref2VA Video Prompt Skill · Toonflow

Turn the storyboard segment, actual uploaded image slots, and selected dialogue locale into the MiniMax H3 full-reference prompt. Return exactly six sections, in this order: `subject_definitions:`, `summary:`, `retention_analysis:`, `detailed_description:`, `overall_soundscape:`, `non_diegetic_music:`. Visual/instruction prose is English. Only spoken dialogue, original-language visible text and requested lyrics use their own languages. Do not add notes outside these six sections.

## Inputs and authoritative source hierarchy

`target_duration` = fixed clip budget. `referenceSlots` = ordered, ACTUALLY uploaded image list; item 1 means `<Picture 1>`. `assetDefinitions` provide asset ID, parent identity, current state and each image's reference role (`BOARD` / `FACE` / `FRONT` / `SIDE` / `BACK`). `storyboardGuidance` provides text-only camera/staging guidance. `storyboardItem` defines current shot, timing and original dialogue. `dialogue_locale` is `original` (default) or an explicitly chosen BCP-47 language/region tag such as `zh-CN`, `en-US`, `en-GB`, `ja-JP`.

A four-panel BOARD image is ONE Picture containing the SAME character's head portrait, front full body, 90-degree side full body and back full body (in that order). It defines ONE `<Subject N>`; never interpret the board as four people, a four-panel target video, or a first-frame composition. When independent views are selected, FACE / FRONT / SIDE / BACK refer to the SAME character, identity and current transformation state. Do not guess missing angles. Reference image roles constrain only what is visible in the current shot: BACK controls rear hair, outfit back and silhouette, SIDE controls profile and side outfit, FACE controls visible facial identity, FRONT controls front outfit and proportions. During a turn preserve the same one Subject as visible surfaces change.

The ordered reference slots are authoritative. Never reorder, fabricate or silently substitute a Picture. A storyboard image is NOT uploaded as a Picture and is not authoritative for identity. If an asset reference or active state conflicts with the current shot, request correction of the binding instead of producing a plausible but incorrect six-section prompt. The active character transformation state overrides conflicting base-state clothing/eye effects. Do not show base and awakened forms as two simultaneous characters. Do not introduce aesthetic details or accessories unsupported by approved assets or script.

## Language selection and fixed time budget

If `dialogue_locale=original`, copy each original script line verbatim and use its actual language tag in `<d>[Language] ...</d>`.

If a locale is explicitly selected, translate ONLY dialogue and spoken voice-over into natural spoken language for that locale. Preserve the original dialogue separately in the source data; do not repeat or speak both translations in the video. Do not translate character identities, image labels, descriptions, visual prompts or UI text. Keep names, story meaning, stable speaker IDs and emotional intent. Use `[English]` for `en-US`/`en-GB` while matching the requested regional speech, `[Chinese]` for `zh-CN`, `[Japanese]` for `ja-JP`, etc. Language choice is a request, not a guarantee that the model will pronounce or lip-sync every supported language perfectly.

Estimate NATURAL spoken length after translation before scheduling shots. Speech may overlap compatible actions, but the total audible speech of one speaker cannot exceed actual available playback time. If the translated words, indispensable actions and transitions cannot fit in `target_duration`, report that the storyboard needs a local rewrite, compression, or split; do not change the whole episode duration, invent a longer H3 clip, drop original meaning or unrealistically accelerate dialogue. Preserve unaffected shots. The calling process, not the language model, must approve any episode-level duration increase.

## Official Subject versus Picture semantics

Use `<Subject N>` for reusable visible subjects. For example, `<Subject 1> is Kor in the current awakened state, defined by <Picture 1> (one four-view board)` OR `defined by <Picture 1> (back), <Picture 2> (side), <Picture 3> (face)`. A standalone `<Picture N>` is defined only if that actual input image is an explicitly requested first frame, keyframe or composition anchor. One role/identity/state is never split into multiple Subjects due solely to multiple views. A full four-view board is an identity reference, not an instruction to produce a four-up video.

## Required output

`subject_definitions:` Define each Subject once, with positive observable identity, current-state, costume, scene topology and prop anchors. Identify which ACTUAL Pictures define it and each Picture's role. No guessed age, height, tattoo, accessories or unrequested transformation.

`summary:` Start with `[reference generation]` when in image-reference mode; one short paragraph covering the current subject(s), scene action and shot flow. Do not invent more subjects or images.

`retention_analysis:` One line per reusable Subject and any separately defined keyframe, with ONLY `fully_preserved`, `partially_preserved`, `attribute_transfer` or `weak_reference`; explain concrete visual characteristics retained/changed in the shots. The Picture sources used solely to define a Subject do not each need an independent target-frame retention entry. A current-state identity must not be overwritten with incompatible parent-form appearance.

`detailed_description:` Start with one or two English sentences for cinematic stylized 3D-anime CG, the current environment, lighting and composition. Then `[Shot 1]` without a timestamp and optionally `[Shot N] At MM:SS.mmm, ...` with strictly increasing times less than target_duration. At first appearance anchor each Subject's actual visible front/side/back features and position. Describe executable action progression, one clear camera path per shot, facial direction when visible, transitions and diegetic sounds. Do not copy the four-panel BOARD arrangement into the target frame.

Time/action budget: for 0–5 s, usually one principal action and one shot; for >5–10 s, one or two actions and up to roughly three distinct shots; for >10–15 s, two or three principal actions and only essential transitions. A transformation must have an explicit BEFORE → onset → AFTER boundary. Do not perform a full complex change repeatedly in every segment.

`overall_soundscape:` Brief English account of ambience, physical effects and nonverbal vocals, not duplicate full dialogue or introduce music.

`non_diegetic_music:` `N/A` unless the actual script explicitly requests audience-only background score; otherwise describe it concisely in English.

## Dialogue syntax and acceptance

Assign `(S1)`, `(S2)` in the order speakers first talk, keeping IDs stable across the clip. A speaking role uses `<Subject 1> (S1) says, <d>[English] Translated line.</d>` or the selected language tag. Acting notes and mouth movement stay outside `<d>`. Retain original dialogue in the source data even when generating translated speech, and never translate or fabricate extra narrative dialogue.

Before returning: six sections exactly once; Picture IDs are actual ordered uploads; BOARD and multiple views produce one reusable Subject per character; one active state per shot; no storyboard Picture invented; requested spoken language matches all generated dialogue/VO; translated speech fits the fixed budget or the process reports infeasibility; stable speaker IDs and action/camera timing are feasible; music N/A unless explicitly requested.
