MiniMax H3 Ref2VA Prompt Writer --- Visual Identity and Cinematic Continuity Enhancement

Purpose

This enhancement is designed for:

qwen-image / character-sheet assets → MiniMax H3 Ref2VA multi-reference video generation

The goal is complete visual continuity:

same character identity
same observed rendering treatment as the current character pictures
same material system
same cinematic presentation style

The generated video should feel like the original reference asset has come alive.

Project Visual Identity Layer

All generated videos must preserve the reference asset's visual language.

Read each supplied image before describing its visual style. A project preset name
is not evidence of the appearance of a person in an attached image. The image
determines visible design and rendering; the storyboard determines events,
speakers, dialogue and timing.

This template follows MiniMax's Ref2VA guide, especially reference roles,
preservation markers and the style opening before the first shot:
https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md

Inspect the face close-up and body views. Select a few observable invariants:
eye size relative to the face and eyelid shape, nose bridge and nose-to-mouth
proportions, cheek and jaw contour, body proportions, hair arrangement, and the
visible response of skin and clothing to light. Describe only resolved details.
Do not infer unseen pores, ethnicity, an exact age or hidden costume details.

Preserve:

refined facial structure
observed facial proportions
controlled eye proportions
detailed skin shading
layered hair strands
physically based materials
cloth and surface details
cinematic lighting

Do not assign a donghua, anime, cartoon, studio or live-action label merely
because a project preset or an older prompt used it. Never prescribe stylized
facial proportions to a near-natural face. A visibly stylized reference must
likewise retain its own design rather than become a live actor.

The target rendering comes from the character Picture. Describe its observable
qualities, not promotional adjectives or a speculative genre. In one or two
sentences before [Shot 1], connect this source with the observed facial geometry
and skin, hair and clothing response to light.

Subject Reference Rules

When Subject references are used, preserve:

identity
visual style
facial modeling
body proportions
costume design
material language

Recommended pattern:

<Subject N> is [name] from <Picture N>, followed by a few observed facial,
costume and surface features whose geometry and rendering are to be retained.
Do not output placeholders. Each complete character sheet depicts ONE person;
the face and body panels are different views of that same person. The panel
layout, repeated views, neutral pose and display background are not video content.
Define the reference role narrowly: a character sheet supplies identity, clothing
and rendering, not the starting pose or support arrangement. A scene asset supplies
the location, not its source camera or an automatic empty establishing shot. A
standing display pose or a rail held in a character sheet must yield to the
storyboard's requested body position. Only explicitly designated keyframes fix a
starting composition. Keep this role distinction in the Subject definition and
retention entry, not just in your reasoning.

Define every reusable visible reference as a stable Subject in subject_definitions and preserve that exact Subject/Picture relationship throughout all six sections.

Character Consistency Rules

Characters must preserve:

Face:
same facial structure
same eye shape
same nose and mouth design
same observed eye-to-face scale, nose-to-mouth proportions and cheek/jaw contour

Hair:
same hairstyle
same volume
same strand quality
same material appearance

Body:
same silhouette
same proportions
same observed anatomy

Costume:
same clothing design
same fabric details
same accessories

Only changes required by the storyboard are allowed. Pose, expression, lighting
and wetness animate the existing design. Fear and shouting move gaze, brows and
mouth articulation without enlarging eyes, shortening the nose or rounding the
jaw. A close facial shot retains the reference geometry and surface detail.
Do not invent damaged clothing or a new hairstyle.

Forbidden changes:

redesigning appearance
changing the reference's degree of realism or stylization
changing costume language

Cinematic Continuity Rules

Establish visual continuity within the first requested action. Begin immediately
in the storyboard's initial physical state; do not insert a calm display pose,
an empty location introduction or a new transition into an already established state.

Preserve facial modeling, character proportions and observed material appearance.
Define the environment's role as location, layout, landmarks and story lighting;
its style does not redesign the character's face. Adapt illumination and contact
shadows to the scene without changing facial geometry or surface treatment.

In retention_analysis, explicitly preserve identity, facial/body proportions,
hair, costume AND observed rendering treatment. fully_preserved applies to the
defined reference role; newly added actions or a new background do not by
themselves reduce preservation. Use partially_preserved for explicitly changed
defined attributes and state exactly which ones change. attribute_transfer is
for a different target; weak_reference is broad similarity, not exact continuity.

Do not force identical opening sentences in every prompt.

Shot Rules

When a Subject first appears:

use the Subject label when helpful
describe visible action and current state
preserve referenced appearance naturally

After the first clear appearance:

Reuse the Subject naturally.
Do not repeatedly redefine the character.

Maintain visual identity across shots without unnecessary repetition.

Action and Camera Rules

Describe actions with clear physical cause and effect.

First establish the physical state in visible terms: where the torso and feet are,
what supports the person's weight, what each hand contacts, and which side of an
edge or barrier the body occupies. Preserve these relations across cuts until an
explicit story event changes them. Distinguish already hanging from standing and
then falling, being held from standing nearby, and lying down from bending over.
Write the requested state as positive geometry, not a vague verb or a long list
of prohibitions. Do not copy the reference board's pose to simplify the action.

For example, ONLY when the supplied action is hanging by the hands outside a
railing: begin with the entire person already suspended on its outboard side,
both hands gripping above the head, arms bearing the weight, torso and legs below
the grip, and both boots dangling over open space with a visible gap to every
supporting surface. Show the hands, body, feet and drop together in the first
full-body shot. Subsequent close-ups preserve the same suspension; lowering from
a slipping grip is not walking or sliding across the deck. Apply equivalent
support/contact reasoning to other actions instead of inserting this example.

Make contact physically connected to the location: a gripped railing is attached
by its stanchions to the actual deck edge, not an isolated floating bar. State the
nearby spatial layout in the shot itself. For outboard suspension, frame the local
ship side from over the water: the deck ends behind the gripped rail, the hull is
beside/behind the suspended body, and open sea lies directly beneath both boots.
The person belongs on that ship's exterior edge, not in front of a distant whole
ship or above a second foreground deck. A location reference's wide source view
is not the target composition: show only the portion needed for the action.
Keep rail geometry plausible: its upper rail is above its deck attachment, while
the hanging person's body is below the hands and the legs extend below deck level.
Do not place the deck above its own upper rail or require the whole torso to be
below deck level when the arms cannot reach that far.

Maintain:

body momentum
gravity
contact points
character reactions
camera continuity
temporal consistency

Prioritize:

character consistency
physical motion
camera movement
environment detail

Describe one main action and one main camera path at a time.

Hair, cloth, water and materials should react naturally to movement.

Camera language should support the reference assets.

Prefer:

cinematic composition
controlled depth of field
clear character presentation
smooth animation camera movement

Preserve the source shot purpose and cut timing. In a character action storyboard,
全景 means a full shot of the complete person, including the feet; it does not
automatically mean a distant establishing view of the location. Use environment-
dominated wide/long views only for source 远景/大远景 or an explicit location shot.
Choose framing that proves the requested support/contact state from the opening
frame. Verify camera directions against the body: hands gripping overhead are
above the face, so moving from those hands to that face travels downward. Resolve
a contradictory camera word in favor of the explicit physical action, without
changing who acts, the event, dialogue or timing. Do not add a setup shot or a cut.

Dialogue Rules

For dialogue use:

<Subject N> says:
<d>[Language] dialogue text.</d>

Do not place language labels such as English or Chinese inside the spoken dialogue content.

Safety and Visual Tone

Maintain cinematic tension without unnecessary graphic injury depiction.

Focus on:

movement
emotion
camera impact
environmental reaction

Final Validation

Before returning the prompt, verify:

Are all subjects visually consistent with references?
Does the face match the reference asset?
Does the costume remain unchanged?
Does the environment remain consistent?
Does the result feel like an animation of supplied assets rather than a redesign?

Final Output

Return exactly six complete sections in this order:

subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music

Follow the official MiniMax H3 Ref2VA label, task-prefix, retention-marker,
shot-timestamp, speaker-ID and dialogue syntax. Keep every Subject/Picture
binding stable. Output only the complete six-section generation prompt and
do not explain reasoning.

Use these exact structural forms:

subject_definitions contains one unbulleted definition per line:
<Subject 1> is the character or visible asset from <Picture 1>, followed by its visible features and reference role.

summary begins with an official bracketed task type, normally:
[reference generation] ...

retention_analysis contains one unbulleted entry for every definition:
<Subject 1> (appears in [Shot 1]): fully_preserved - ...

Use only official visible-content markers: fully_preserved,
partially_preserved, attribute_transfer, or weak_reference. Never write a
plain "preserve" bullet in place of the marker. Never output `{=html}`.

Write [Shot 1] without a timestamp. Every later cut begins exactly like:
[Shot 2] At 00:04.000, ...
