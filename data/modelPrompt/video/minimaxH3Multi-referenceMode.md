# MiniMax H3 Ref2VA Prompt Skill

This skill adapts Toonflow inputs to the official MiniMax H3 full-reference prompt format.

## Required output structure

Return exactly these six sections, in this order:

subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:

All six sections must be written in English. Preserve only dialogue, lyrics, and visibly rendered scene text in their original language.

## Toonflow input mapping

Toonflow may provide:

- target_duration: target video duration in seconds.
- <referenceSlots>: the actual ordered images uploaded to H3 Ref2VA.
- <assetDefinitions>: asset name, type, description, and image prompt.
- <storyboardGuidance>: shot-planning information extracted from storyboard images; these images are not uploaded to Ref2VA.
- <storyboardItem>: factual scene, action, camera, dialogue, sound, and timing information.
- project visual-style context.

referenceSlots is the runtime source mapping:

slot 1 = <Picture 1>
slot 2 = <Picture 2>
...
slot N = <Picture N>

Never reorder these slots and never invent a Picture index that is not present.

storyboardGuidance is text-only planning input. It may guide composition, staging, action, camera movement, spatial relationships, and shot order, but it must not receive a new Picture label.

## Official reference semantics

Use <Subject N> for reusable visible content such as characters, creatures, environments, props, interfaces, clothing, or visual effects.

When an uploaded image only defines a reusable subject, cite its Picture source inside that Subject definition instead of making the Picture itself the reusable identity.

Example pattern:

<Subject 1> is the woman shown in <Picture 1>, preserving the observable facial structure, hairstyle, skin tone, body proportions, wardrobe identity, and key accessories shown in the reference.

Use a standalone <Picture N> definition only when the image itself functions as a concrete first frame, keyframe, last frame, edited frame, or composition anchor.

For the current Toonflow H3 asset-reference flow, role/scene/tool/creature images normally become Subject sources.

## subject_definitions

Start with exactly:

subject_definitions:

Create one line for every separately reusable visible Subject.

Use concrete positive visual details from assetDefinitions whenever available.

For a character, positively specify the identity features that should remain visually continuous: face structure, apparent age, hairstyle, hair color, skin tone, body proportions, wardrobe identity, and key accessories.

For an environment, specify layout, structure, lighting, weather, and spatial features.

For a prop or interface, specify shape, material, color, layout, scale, and defining design details.

For a creature, specify body proportions, silhouette, surface texture, head or limb structure, scale, and defining features.

## summary

Start with exactly:

summary:

For this Toonflow image-reference workflow, normally use the task prefix:

[reference generation]

Write one short English paragraph summarizing the target video, main Subjects, shot flow, and reference relationships. Introduce no new reference labels here.

## retention_analysis

Start with exactly:

retention_analysis:

Use one line per defined reference item.

For visible references, only use these official relationship markers:

fully_preserved
partially_preserved
attribute_transfer
weak_reference

Prefer positive preservation statements that describe what remains consistent. Do not turn this section into a list of failure cases or negative prompts.

## detailed_description

Start with exactly:

detailed_description:

This is the main execution body.

Before [Shot 1], establish the target visual style in one or two concrete English sentences. Prefer observable rendering, lighting, palette, material, texture, and atmosphere details over vague adjectives.

Shot timing rules:

- [Shot 1] has no timestamp.
- Every later shot begins with a strictly increasing cut time, such as:
  [Shot 2] At 00:05.000, ...
- All timestamps must fit within target_duration.
- The described sequence must end within the requested duration.

For every shot, describe the current composition, visible Subjects and positions, environment and lighting, observable actions and state changes, camera movement, current diegetic sound, and the point where referenced content is visible or takes effect.

At the first clear appearance of an important Subject, establish enough of its referenced appearance and placement to make the identity clear. Reuse the same Subject label later without redefining it.

Write camera movement naturally in the prose. When useful, describe movement type, amplitude, and speed.

## Dialogue and speakers

Assign stable speaker IDs in order of actual vocal events: (S1), (S2), and so on.

A referenced speaking character should use both its Subject label and speaker ID.

Dialogue must use the official form:

<Subject 2> (S1) says, <d>[Chinese] 原始中文台词。</d>

Keep the spoken words in their original language. Put delivery, expression, voice quality, action, and mouth movement outside the <d> block.

Do not repeat full dialogue in overall_soundscape.

## Positive-detail priority

Generation instructions should primarily state what H3 should render, preserve, move, show, and sound like.

Prioritize:

1. positive subject identity and appearance details;
2. positive action and state changes;
3. positive spatial relationships;
4. positive camera path;
5. positive sound and dialogue execution.

Use exclusions only when they are genuine output requirements and keep them concise.

## overall_soundscape

Start with exactly:

overall_soundscape:

Write a compact English paragraph summarizing ambience, physical action sounds, environmental continuity, and non-verbal human sounds. Do not repeat dialogue or lyrics.

Use N/A only when complete silence is explicitly requested.

## non_diegetic_music

Start with exactly:

non_diegetic_music:

If the user did not request audience-only background music, output:

N/A

If a score is requested, describe instrumentation, tempo, rhythm, and dynamic development in English.

## Asset-detail use

When <assetDefinitions> is present, use it to make Subject definitions concrete. Convert useful visual facts into natural English prose rather than copying an image-generation keyword list verbatim.

Do not expose asset database IDs in the final prompt.

## Final validation

Before returning, verify:

- all six official section names appear once and in the correct order;
- all rewrite prose is English except original-language dialogue, lyrics, and visible scene text;
- every Picture index comes from referenceSlots;
- reusable visible content uses stable Subject labels;
- storyboardGuidance has no invented Picture label;
- summary introduces no new labels;
- retention_analysis uses only valid relationship markers;
- Shot 1 has no timestamp;
- later shots have strictly increasing timestamps;
- timing fits target_duration;
- speaker IDs stay stable;
- dialogue uses <d>[Language] ...</d>;
- overall_soundscape does not repeat dialogue;
- non_diegetic_music is N/A when no score is requested;
- concrete positive instructions dominate over negative prompting.

Return only the six-section H3 prompt with no explanation before or after it.
