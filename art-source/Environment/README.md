# Environment Assets

Reference:
- `art-source/Concepts/04_school_environment_sheet.png`

The school maze environment is built from a modular kit plus reusable props.

## Required Subfolders

- `ModularKit/`: 2m wall/floor/door/light modules.
- `Props/`: lockers, classroom props, playground props, police station props.
- `SampleMaze.unity`: assembled reference scene using the kit and props.

## Shared Rules

- Use real PBR materials, not flat color placeholders.
- Keep geometry clean for NavMesh baking.
- Use tileable materials and trim sheets where possible.
- Large props such as trees and police car need LODs.
- Visual readability must work from the top-down 3/4 camera.
