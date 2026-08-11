# OHIF Viewer AI Coding Guidelines

## Architecture Overview

This is the OHIF (Open Health Imaging Foundation) Medical Imaging Viewer - a web-based DICOM viewer built with React, TypeScript, and CornerstoneJS 3D rendering.

### Monorepo Structure
- **Lerna monorepo** with Yarn workspaces (v3.12.0+)
- **platform/**: Core packages (core, ui, ui-next, viewer, i18n, docs)
- **extensions/**: Feature modules (cornerstone, measurement-tracking, segmentation, DICOM SR/SEG/RT, etc.)
- **modes/**: Workflow configurations (basic, longitudinal, segmentation, tmtv, microscopy)
- **addOns/**: External add-on packages

### Key Architectural Patterns

#### 1. Extension System
Extensions are the primary extension mechanism. Each extension exports modules:
- **commandsModule**: Commands that can be invoked via `commandsManager.run()`
- **panelModule**: UI panels (e.g., segmentation panel, measurement tracking)
- **viewportModule**: Custom viewport implementations
- **toolbarModule**: Toolbar buttons and configurations
- **hangingProtocolModule**: Viewport layout and display rules
- **sopClassHandlerModule**: DICOM SOP Class handling

Example from [extensions/cornerstone/src/index.tsx](extensions/cornerstone/src/index.tsx):
```typescript
export default {
  id: '@ohif/extension-cornerstone',
  getViewportModule,
  getCommandsModule,
  getPanelModule,
  // ...
};
```

#### 2. Service-Oriented Architecture
Services are injected via `servicesManager` and provide core functionality:
- **SegmentationService**: Manages segmentations (labelmap, contour, surface representations)
- **ViewportGridService**: Manages viewport layout and active viewport
- **CornerstoneViewportService**: Handles Cornerstone rendering engine integration
- **DisplaySetService**: Manages DICOM series/display sets
- **HangingProtocolService**: Applies viewport layouts
- **ToolbarService**: Manages toolbar state and sections

Access pattern:
```typescript
const { segmentationService, viewportGridService } = servicesManager.services;
```

#### 3. Command Pattern for Actions
All user actions flow through commands:
```typescript
commandsManager.run('commandName', { /* params */ });
```

Commands are defined in commandsModule and can be invoked from UI components or other commands. See [extensions/cornerstone/src/commandsModule.ts](extensions/cornerstone/src/commandsModule.ts) for extensive examples.

### Medical Imaging Specifics

#### Segmentation Architecture
- **Three representation types**: Labelmap (2D/3D voxels), Contour (polygons), Surface (3D meshes)
- **Surface representation** is used for 3D-only views (segment3D hanging protocol)
- **Visibility synchronization**: For VOLUME_3D viewports, toggling segment visibility syncs both Labelmap and Surface representations
- Segmentations are managed centrally by SegmentationService, which wraps CornerstoneJS Tools segmentation state

Key file: [extensions/cornerstone/src/services/SegmentationService/SegmentationService.ts](extensions/cornerstone/src/services/SegmentationService/SegmentationService.ts)

#### Viewport Types
- **Stack viewports**: 2D slice-by-slice viewing
- **Volume viewports**: 3D volumetric rendering with MPR
- **Volume 3D viewports**: Surface rendering for 3D visualization

#### Hanging Protocols
Define viewport layouts and display rules. See [extensions/cornerstone/src/hps/](extensions/cornerstone/src/hps/) for examples:
- `segment3D.ts`: 3D segment view with Surface representation
- `mpr.ts`: Multi-planar reconstruction
- `fourUp.ts`: 2x2 grid layout

### Critical Developer Workflows

#### Development Setup
```bash
yarn install --frozen-lockfile
yarn run dev              # Start development server
yarn run dev:fast         # Experimental rsbuild mode
```

#### Building
```bash
yarn run build            # Production build
yarn run build:dev        # Development build
```

#### Testing
- Unit tests: Jest in each package
- E2E tests: Playwright in `/tests` directory

### Project-Specific Conventions

#### Import Aliases
Configured in [aliases.config.js](aliases.config.js) and used throughout:
- `@ohif/core`, `@ohif/ui`, `@ohif/ui-next`, `@ohif/extension-default`
- `@cornerstonejs/core`, `@cornerstonejs/tools`, `@cornerstonejs/streaming-image-volume-loader`

#### UI Component Libraries
- **Old UI**: `platform/ui` (legacy React components)
- **New UI**: `platform/ui-next` (modern components with Radix UI primitives)
- Prefer using `ui-next` for new features
- SegmentationTable is in ui-next and provides built-in segment visibility controls

#### Event Broadcasting
Services use PubSub pattern:
```typescript
service.subscribe(service.EVENTS.EVENT_NAME, (eventData) => { /* ... */ });
service._broadcastEvent(this.EVENTS.EVENT_NAME, { data });
```

### Integration Points

#### CornerstoneJS Integration
The application wraps Cornerstone3D library:
- Rendering engine managed by CornerstoneViewportService
- Segmentation tools managed by SegmentationService
- Caching and loading managed by Cornerstone loaders

#### DICOM Data Flow
1. DICOM instances loaded via DicomMetadataStore
2. DisplaySets created from instances
3. HangingProtocols determine viewport layout
4. Viewports render DisplaySets using Cornerstone

### Common Patterns for AI Agents

#### Adding a New Segmentation Feature
1. Add method to SegmentationService if needed
2. Create command in commandsModule
3. Wire command to UI in panel or toolbar
4. Test with both 2D and 3D viewports

#### Modifying Viewport Behavior
1. Check hanging protocol definition in `extensions/cornerstone/src/hps/`
2. Modify viewport initialization in CornerstoneViewportService
3. Consider impact on all viewport types (Stack, Volume, Volume3D)

#### Segment Visibility Toggle (Example)
Already implemented - demonstrates the full stack:
- **Service method**: `SegmentationService.toggleSegmentVisibility()` - syncs Labelmap and Surface for 3D
- **Command**: `toggleSegmentVisibility` in commandsModule
- **UI**: `onToggleSegmentVisibility` in SegmentationSegments component
- **3D handling**: Automatic sync for VOLUME_3D viewports with Surface representation

See implementation in:
- [SegmentationService.ts](extensions/cornerstone/src/services/SegmentationService/SegmentationService.ts#L1028-L1061)
- [SegmentationSegments.tsx](platform/ui-next/src/components/SegmentationTable/SegmentationSegments.tsx#L183)

### Key Files to Reference
- `platform/core/src/services/ServicesManager.ts`: Service registry
- `platform/core/src/classes/CommandsManager.ts`: Command execution
- `extensions/cornerstone/src/init.tsx`: Extension initialization and event wiring
- `extensions/cornerstone/src/commandsModule.ts`: All Cornerstone commands
- `platform/app/src/appInit.ts`: Application bootstrapping

### Debugging Tips
- Use browser DevTools "Sources" to set breakpoints
- Cornerstone viewports accessible via `window.cornerstone3D`
- Services accessible via window for debugging: `window.services = servicesManager.services` (add to init)
- Check EVENTS for proper event broadcasting (SEGMENTATION_MODIFIED, VIEWPORT_DATA_CHANGED, etc.)

### Branch Strategy
- `master`: Latest development (beta releases)
- `release/*`: Stable releases (e.g., `release/3.5`, `release/3.6`)
