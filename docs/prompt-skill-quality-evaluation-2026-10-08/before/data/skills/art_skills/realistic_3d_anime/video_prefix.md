# 视频渲染目标 · 参考优先的半写实三维

## Character Reference

Each character uses one complete reference sheet in one Picture slot. Face close-up, front full body, side full body and back full body panels, when visible, show the same person, never separate characters. Explicitly state this relationship in the character definition. Keep the same facial proportions, including the observed eye-to-face size, nose structure and jaw shape, hairstyle, body proportions, clothing structure and accessories throughout motion. Do not copy the sheet layout, repeated figures or display background into the video. Changes require an explicit timed story transition; rendering style must not override identity.

The character sheet's display pose and incidental support props do not determine the action. Define its role as appearance and rendering; take the starting body position, hand contacts, weight support and foot placement from the storyboard. Preserve identity while replacing the display pose with the requested action from the first frame. A scene reference is a location reference unless explicitly designated as a target keyframe; its distant composition must not replace the required character framing.

## Environment Reference

The provided environment image defines the location: preserve its architecture, spatial layout, background landmarks, lighting direction and atmosphere. Do not substitute a generic scene. Weather and illumination change only as required by the story; maintain coherent lighting on characters and surroundings.

## Video Style

Derive the target rendering from the current character images, not from the internal preset name realistic_3d_anime. The default cinematic semi-realistic 3D animation direction applies only to qualities the references actually show; it must not add stylization to a near-natural face. Describe the observed eye-to-face size, eyelid shape, nose bridge, cheek/jaw contour and surface reflections in a few concrete terms. Preserve hair strand and bundle structure, visible fabric texture and drape. Apply physically based scene lighting and story-required wetness as illumination and surface-state changes while preserving those facial and material characteristics. Characters and surroundings share coherent lighting and contact shadows.

In the final prompt, use one or two opening sentences to explicitly connect facial proportions and visible material appearance to the current character Pictures. Express that source relationship with observed features; generic 3D quality adjectives alone do not convey it. Do not insert a donghua, anime, cartoon, studio or live-action label merely because a preset or an older prompt used it. Preserve the selected character designs. Relighting changes light on the existing face, not its geometry. Fear and shouting move the brows, gaze and mouth without enlarging the eyes or rounding the jaw. Keep these design and rendering invariants in the character's reference role and retention entry as well as the close-up description.

## Action, Camera, Sound

Prioritize character consistency, physical motion, camera movement, then environmental detail. Describe observable actions and results in short sentences, with one main action and one main camera path at a time. Preserve who acts on whom; avoid long nested cause-and-effect clauses and invented secondary events. Hair, cloth and water respond naturally to the main motion. Establish framing using wide establishing shot, medium interaction shot, close facial shot, tracking shot or high angle shot as appropriate. Add synchronized physical sounds and only supplied speech.

Place character and environment definitions in subject_definitions, then preserve those exact identities in summary, retention_analysis and detailed_description. Put the style opening before [Shot 1], then describe action, camera and synchronized sound inside the official detailed_description structure. Do not rename, omit or reorder the six official MiniMax H3 Ref2VA sections.

## Prompt Quality Enhancement

Use the provided references as the visual foundation for the entire sequence.

Preserve:
- character identity
- facial structure
- hairstyle and hair behavior
- clothing design and material response
- lighting direction
- environment continuity

Describe actions with clear physical cause and effect.

Maintain:
- body momentum
- gravity
- contact points
- character reactions
- camera continuity
- temporal consistency

For dialogue, use:

<Subject N> says:
<d>[Language] dialogue text.</d>

Do not put language labels such as English or Chinese inside the spoken dialogue content itself.

Maintain cinematic tension without unnecessary graphic injury depiction. Focus on:
- movement
- emotion
- camera impact
- environmental reaction
