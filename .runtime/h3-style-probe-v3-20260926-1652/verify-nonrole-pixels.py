"""Local CPU check: reproduce installed common_upscale/lanczos for RGB inputs.

Read original uploads only. Do not import/load any model or call ComfyUI APIs.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

run = Path(__file__).resolve().parent
manifest = json.loads((run / 'style-probe-manifest.json').read_text(encoding='utf-8'))


def installed_lanczos(image, width, height):
    # Identical float->uint8, Pillow LANCZOS, and uint8->float32 path to comfy.utils.lanczos.
    pil = Image.fromarray(np.clip(255. * image, 0, 255).astype(np.uint8))
    resized = pil.resize((width, height), resample=Image.Resampling.LANCZOS)
    return np.array(resized).astype(np.float32) / 255.0


results = []
for ref in manifest['references'][2:]:
    source = Path('D:/new_comfyui/input') / ref['uploadedFilename']
    with Image.open(source) as im:
        image = np.array(im.convert('RGB')).astype(np.float32) / 255.0
    old_size = (ref['previousEffectiveWidth'], ref['previousEffectiveHeight'])
    new_size = (ref['effectiveWidth'], ref['effectiveHeight'])
    assert old_size == new_size
    old = installed_lanczos(image, *old_size)
    prescaled = installed_lanczos(image, *new_size)
    candidate = installed_lanczos(prescaled, *new_size)
    equal = np.array_equal(old, candidate)
    result = {'picture': ref['picture'], 'assetId': ref['assetId'],
              'width': new_size[0], 'height': new_size[1], 'identicalFloat32Pixels': equal,
              'oldSha256': hashlib.sha256(old.tobytes()).hexdigest(),
              'candidateSha256': hashlib.sha256(candidate.tobytes()).hexdigest()}
    results.append(result)
    assert equal, f"Non-role pixels differ: {result}"
(run / 'nonrole-pixel-equivalence.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
print(json.dumps(results, indent=2))
