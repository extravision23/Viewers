# Trajectory Planner (OHIF)

Neurosurgical trajectory planning integrated into OHIF segmentation mode.

## Usage

1. Open **Segmentation** mode with a labelmap segmentation.
2. In the segmentation panel, click **Trajectory Planner** (next to Preview 3D).
3. Wait for SEG→GLB conversion via `ConvertDicomToObj`.
4. In the dialog:
   - Assign **TARGET**, **ENTRY_SURFACE**, **OBSTACLE** roles per segment.
   - Click **Plan trajectory**; hold **Shift** to edit entry/direction (wheel = corridor radius).
   - **Save manual trajectory** → **Generate AI suggestion** → compare → **Export JSON**.

## Architecture

- `@extravision/trajectory-planner` — voxel PCA pipeline (`optimizeTrajectories`), shared with `trajectory_tool/`.
- `@extravision/extension-trajectory` — OHIF commands + `TrajectoryPlannerDialog` (Three.js).
- Meshes are generated in **LPS patient space (mm)**; verify alignment on first clinical case.

## Configuration

Requires the same Azure function base URL as 3D Preview (`pythonFunctionsBaseUrl` / `ConvertDicomToObj` in data source config).

## Disclaimer

Research and educational use only. Not a certified medical device.
