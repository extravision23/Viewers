# Trajectory Planner (OHIF)

Neurosurgical trajectory planning integrated into OHIF segmentation mode.

## Usage

1. Open **Segmentation** mode with a labelmap segmentation.
2. In the segmentation panel, click **Trajectory Planner** (next to Preview Glasses).
3. Wait for SEG→GLB conversion via `ConvertDicomToObj`.
4. In the dialog:
   - Assign **TARGET**, **ENTRY_SURFACE**, **OBSTACLE** roles per segment.
   - Click **Plan trajectory**; hold **Shift** to edit entry/direction (wheel = corridor radius).
   - **Save manual trajectory** → **Generate AI suggestion** → compare → **Export JSON**.

## Architecture

- `@extravision/trajectory-planner` — voxel PCA pipeline (`optimizeTrajectories`), shared with `trajectory_tool/`.
- `@extravision/extension-trajectory` — OHIF commands + `TrajectoryPlannerDialog` (Three.js).
- Meshes are generated in **LPS patient space (mm)**; verify alignment on first clinical case.

## Scoring (length-aware)

```
Score = α·coverage − β·extracerebral_mm − γ·proximity − δ·total_length_mm
```

Defaults favour shorter extracerebral / total path (`β=1.2`, `δ=0.7`) over deep lesion coverage alone. Search cone defaults to **35°** (widens further when PCA is unstable).

## Configuration

Requires the same Azure function base URL as 3D Preview (`pythonFunctionsBaseUrl` / `ConvertDicomToObj` in data source config).

## Disclaimer

Research and educational use only. Not a certified medical device.
