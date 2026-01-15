import React, { useEffect, useMemo, useState } from 'react';
import { useSystem } from '@ohif/core';
import { useMagicWandSegmentation } from '../hooks/useMagicWandSegmentation';

type ServerSideSegmentationPanelProps = withAppTypes;

interface CTPreset {
  value: string;
  label: string;
  segMinHu: number;
  segMaxHu: number;
}

const PRESETS: CTPreset[] = [
  {
    value: 'bone',
    label: 'Bone',
    segMinHu: 300.0,
    segMaxHu: 3000.0,
  },
  {
    value: 'soft_tissue',
    label: 'Soft Tissue',
    segMinHu: -100.0,
    segMaxHu: 250.0,
  },
  {
    value: 'cta_vessels',
    label: 'Vessels',
    segMinHu: 150.0,
    segMaxHu: 700.0,
  },
  {
    value: 'brain_csf_80_40',
    label: 'CSF',
    segMinHu: -5.0,
    segMaxHu: 20.0,
  },
  {
    value: 'brain_csf_130_50',
    label: 'CSF (130/50)',
    segMinHu: -5.0,
    segMaxHu: 20.0,
  },
  {
    value: 'ich_acute',
    label: 'Acute ICH',
    segMinHu: 40.0,
    segMaxHu: 90.0,
  },
];


export default function ServerSideSegmentationPanel(props: ServerSideSegmentationPanelProps) {
  const { servicesManager, extensionManager, commandsManager } = useSystem();
  const { uiNotificationService, segmentationService, displaySetService } = servicesManager.services;

  const { mode, error, seedMarker, options, setOptions, startPickingSeed } =
    useMagicWandSegmentation();

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isRunningOneClick, setIsRunningOneClick] = useState(false);
  const [isRunningByPreset, setIsRunningByPreset] = useState(false);
  const [selectedPresets, setSelectedPresets] = useState<string[]>(['bone']);
  const [minHu, setMinHu] = useState<string>('300');
  const [maxHu, setMaxHu] = useState<string>('3000');

  const activeDataSource = useMemo(() => {
    const [ds] = extensionManager?.getActiveDataSource?.() ?? [];
    return ds;
  }, [extensionManager]);

  // Auto-fill HU range when single preset is selected
  useEffect(() => {
    if (selectedPresets.length === 1) {
      const preset = PRESETS.find(p => p.value === selectedPresets[0]);
      if (preset) {
        setMinHu(preset.segMinHu.toString());
        setMaxHu(preset.segMaxHu.toString());
      }
    } else if (selectedPresets.length > 1) {
      // Clear HU range when multiple presets selected
      setMinHu('');
      setMaxHu('');
    }
  }, [selectedPresets]);

  const togglePreset = (presetValue: string) => {
    setSelectedPresets(prev =>
      prev.includes(presetValue) ? prev.filter(p => p !== presetValue) : [...prev, presetValue]
    );
  };


  const runSegmentationByPreset = async () => {
    if (isRunningByPreset || selectedPresets.length === 0) {
      return;
    }

    const { viewportGridService, displaySetService } = servicesManager.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const { viewports } = viewportGridService.getState();
    const viewport = viewports.get(viewportId);

    if (!viewport || !viewport.displaySetInstanceUIDs?.length) {
      uiNotificationService?.show({
        title: 'Segmentation by preset',
        message: 'No active viewport or display set found.',
        type: 'error',
      });
      return;
    }

    const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

    if (!displaySet) {
      uiNotificationService?.show({
        title: 'Segmentation by preset',
        message: 'No display set found for active viewport.',
        type: 'error',
      });
      return;
    }

    const { StudyInstanceUID: studyInstanceUID, SeriesInstanceUID: seriesInstanceUID } = displaySet;

    try {
      setIsRunningByPreset(true);

      // Only send customSegRange if single preset selected and HU values provided
      const customSegRange =
        selectedPresets.length === 1 && (minHu || maxHu)
          ? {
              minHu: minHu ? parseFloat(minHu) : undefined,
              maxHu: maxHu ? parseFloat(maxHu) : undefined,
            }
          : null;

      const result = await commandsManager.runCommand('segmentByPreset', {
        studyInstanceUID,
        seriesInstanceUID,
        preset: selectedPresets,
        customSegRange,
        viewportId,
      });

      if (result === null) {
        return;
      }

      const segSeriesInstanceUID = result?.segmentation?.seriesInstanceUID;

      if (!segSeriesInstanceUID) {
        uiNotificationService?.show({
          title: 'Segmentation by preset',
          message: 'Server did not return segmentation series information.',
          type: 'error',
        });
        return;
      }

      // Remove active saved segmentation from left panel before refetching
      // This prevents duplication when the updated segmentation is loaded
      const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
      if (activeSegmentation) {
        const activeSegmentationId = activeSegmentation.segmentationId;
        const activeSegDisplaySet = displaySetService.getDisplaySetByUID(activeSegmentationId);
        // Check if segmentation is saved (has SeriesInstanceUID and is not madeInClient)
        const isSaved =
          activeSegDisplaySet &&
          activeSegDisplaySet.SeriesInstanceUID &&
          !(activeSegDisplaySet as any).madeInClient;
        if (isSaved) {
          displaySetService.deleteDisplaySet(activeSegmentationId);
          console.log('Removed active saved segmentation from left panel before refetching');
        }
      }

      // Refresh study/series metadata so DisplaySetService sees the new SEG
      if (activeDataSource) {
        // Bust any cached study metadata so new series can be discovered.
        // The cache key in retrieveStudyMetadata is `${dicomWebConfig.name}:${StudyInstanceUID}`,
        // so we need to match that format to actually clear it.
        const dsConfig = activeDataSource.getConfig?.() ?? {};
        const cacheKey =
          typeof dsConfig.name === 'string'
            ? `${dsConfig.name}:${studyInstanceUID}`
            : studyInstanceUID;

        activeDataSource.deleteStudyMetadataPromise?.(cacheKey);

        if (activeDataSource.retrieve?.series?.metadata) {
          // Most reliable path: retrieve full series metadata for this study
          await activeDataSource.retrieve.series.metadata({
            StudyInstanceUID: studyInstanceUID,
          });
        } else if (activeDataSource.query?.series?.metadata) {
          // Legacy path (DicomWebDataSource)
          await activeDataSource.query.series.metadata({
            StudyInstanceUID: studyInstanceUID,
          });
        } else if (activeDataSource.query?.studies?.search) {
          // Fallback: refresh study list; some implementations update the metadata store here
          await activeDataSource.query.studies.search({
            studyInstanceUID: studyInstanceUID,
          });
        }
      }

      const segDisplaySets = displaySetService.getDisplaySetsForSeries(segSeriesInstanceUID);

      if (!segDisplaySets?.length) {
        uiNotificationService?.show({
          title: 'Segmentation by preset',
          message: 'SEG series was created on the server but is not yet available in the viewer.',
          type: 'warning',
        });
        return;
      }

      const segDisplaySet = segDisplaySets[0];

      await commandsManager.runCommand('hydrateSecondaryDisplaySet', {
        displaySet: segDisplaySet,
        viewportId,
      });

      uiNotificationService?.show({
        title: 'Segmentation by preset',
        message: `Segmentation for preset(s) "${selectedPresets.join(', ')}" loaded successfully.`,
        type: 'success',
      });
    } catch (e) {
      console.error('Error running segmentByPreset command:', e);
      uiNotificationService?.show({
        title: 'Segmentation by preset',
        message: 'Segmentation request failed. Check console for details.',
        type: 'error',
      });
    } finally {
      setIsRunningByPreset(false);
    }
  };

  const runOneClickSegmentation = async (apiPath: string, label: string) => {
    if (isRunningOneClick) {
      return;
    }

    const { viewportGridService, displaySetService } = servicesManager.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const { viewports } = viewportGridService.getState();
    const viewport = viewports.get(viewportId);

    if (!viewport?.displaySetInstanceUIDs?.length) {
      uiNotificationService?.show({
        title: label,
        message: 'No active viewport/series found. Click a viewport first.',
        type: 'error',
      });
      return;
    }

    const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

    if (!displaySet) {
      uiNotificationService?.show({
        title: label,
        message: 'No display set found for active viewport.',
        type: 'error',
      });
      return;
    }

    const { StudyInstanceUID: studyInstanceUID, SeriesInstanceUID: seriesInstanceUID } =
      displaySet;

    try {
      setIsRunningOneClick(true);
      uiNotificationService?.show({
        title: label,
        message: 'Starting segmentation, please wait…',
        type: 'info',
      });

      await commandsManager.runCommand('oneClickSegmentation', {
        studyInstanceUID,
        seriesInstanceUID,
        apiPath,
        viewportId,
      });

      uiNotificationService?.show({
        title: label,
        message: 'Segmentation request triggered successfully.',
        type: 'success',
      });
    } catch (e) {
      console.error(`${label} failed`, e);
      uiNotificationService?.show({
        title: label,
        message: 'Segmentation request failed.',
        type: 'error',
      });
    } finally {
      setIsRunningOneClick(false);
    }
  };

  const handleMagicWandClick = () => {
    startPickingSeed();
  };

  const isDisabled = mode === 'loading' || isRunningOneClick || isRunningByPreset;
  const isHuRangeDisabled = selectedPresets.length !== 1;

  return (
    <div className="flex flex-col space-y-3 p-4">
      <div className="space-y-3">
        <div className="space-y-2">
          <button
            onClick={() => runOneClickSegmentation('segmentdicom', 'Synthetic Segmentation')}
            disabled={isDisabled}
            className={`w-full rounded-md px-4 py-2 font-medium transition-colors ${
              isDisabled
                ? 'cursor-not-allowed bg-gray-600 text-gray-400'
                : 'bg-gray-700 text-white hover:bg-gray-600'
            }`}
          >
            Run Synthetic Segmentation
          </button>
          <button
            onClick={() => runOneClickSegmentation('segmenttumor', 'Tumor Segmentation')}
            disabled={isDisabled}
            className={`w-full rounded-md px-4 py-2 font-medium transition-colors ${
              isDisabled
                ? 'cursor-not-allowed bg-gray-600 text-gray-400'
                : 'bg-gray-700 text-white hover:bg-gray-600'
            }`}
          >
            Run Tumor Segmentation
          </button>
        </div>

        <div className="border-t border-gray-700 pt-3" />

        <div className="space-y-3">
          <div className="text-sm font-medium text-gray-200">Segment by Preset</div>

          <div className="space-y-2">
            <label className="text-sm text-gray-300 opacity-90">Select Preset(s)</label>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {PRESETS.map(p => (
                <label
                  key={p.value}
                  className="flex cursor-pointer items-center gap-2 rounded p-1 hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={selectedPresets.includes(p.value)}
                    onChange={() => togglePreset(p.value)}
                    className="h-4 w-4 cursor-pointer"
                    disabled={isDisabled}
                  />
                  <span className="text-sm text-gray-100">{p.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-gray-300 opacity-90">
              Custom HU range
              {isHuRangeDisabled && (
                <span className="text-xs opacity-60"> (single preset only)</span>
              )}
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="min"
                value={minHu}
                onChange={e => setMinHu(e.target.value)}
                disabled={isDisabled || isHuRangeDisabled}
                className="w-1/2 rounded border border-gray-600 bg-gray-800 p-1 text-white disabled:cursor-not-allowed disabled:opacity-50"
              />
              <input
                type="number"
                placeholder="max"
                value={maxHu}
                onChange={e => setMaxHu(e.target.value)}
                disabled={isDisabled || isHuRangeDisabled}
                className="w-1/2 rounded border border-gray-600 bg-gray-800 p-1 text-white disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>

          <button
            onClick={runSegmentationByPreset}
            disabled={isDisabled || selectedPresets.length === 0}
            className={`w-full rounded-md px-4 py-2 font-medium transition-colors ${
              isDisabled || selectedPresets.length === 0
                ? 'cursor-not-allowed bg-gray-600 text-gray-400'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {isRunningByPreset ? 'Running…' : 'Run Segmentation (Preset)'}
          </button>
        </div>

        <div className="border-t border-gray-700 pt-3" />

        <button
          onClick={handleMagicWandClick}
          disabled={isDisabled}
          className={`w-full rounded-md px-4 py-2 font-medium transition-colors ${
            mode === 'pickingSeed'
              ? 'bg-yellow-600 text-white hover:bg-yellow-700'
              : isDisabled
                ? 'cursor-not-allowed bg-gray-600 text-gray-400'
                : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {mode === 'loading' ? (
            <span className="flex items-center justify-center gap-2">
              <span className="animate-spin">⏳</span>
              Running segmentation…
            </span>
          ) : mode === 'pickingSeed' ? (
            'Cancel (Esc)'
          ) : (
            'Magic Wand'
          )}
        </button>

        {mode === 'pickingSeed' && (
          <div className="rounded bg-yellow-900/30 p-2 text-sm text-yellow-300">
            Click on the image to select seed point (Esc to cancel)
          </div>
        )}

        {error && <div className="rounded bg-red-900/30 p-2 text-sm text-red-300">{error}</div>}

        <div className="border-t border-gray-700 pt-3">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-300"
          >
            <span>{showAdvanced ? '▼' : '▶'}</span>
            Advanced
          </button>

          {showAdvanced && (
            <div className="mt-2 space-y-3 pl-4">
              <div>
                <label className="mb-1 block text-sm text-gray-300">Tolerance</label>
                <input
                  type="number"
                  value={options.tolerance ?? 30}
                  onChange={e =>
                    setOptions({ ...options, tolerance: parseInt(e.target.value) || 30 })
                  }
                  className="w-full rounded border border-gray-600 bg-gray-800 p-1 text-white"
                  min="0"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm text-gray-300">Connectivity</label>
                <select
                  value={options.connectivity ?? 6}
                  onChange={e =>
                    setOptions({
                      ...options,
                      connectivity: parseInt(e.target.value) as 6 | 18 | 26,
                    })
                  }
                  className="w-full rounded border border-gray-600 bg-gray-800 p-1 text-white"
                >
                  <option value={6}>6</option>
                  <option value={18}>18</option>
                  <option value={26}>26</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm text-gray-300">
                  Max Region Voxels (optional)
                </label>
                <input
                  type="number"
                  value={options.maxRegionVoxels ?? ''}
                  onChange={e =>
                    setOptions({
                      ...options,
                      maxRegionVoxels: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="w-full rounded border border-gray-600 bg-gray-800 p-1 text-white"
                  placeholder="500000"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm text-gray-300">
                  Max Radius Voxels (optional)
                </label>
                <input
                  type="number"
                  value={options.maxRadiusVoxels ?? ''}
                  onChange={e =>
                    setOptions({
                      ...options,
                      maxRadiusVoxels: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="w-full rounded border border-gray-600 bg-gray-800 p-1 text-white"
                  placeholder="200"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {seedMarker && (
        <div className="mt-2 text-xs text-gray-400">
          Seed point selected at slice {seedMarker.worldPoint[2]?.toFixed(0)}
        </div>
      )}
    </div>
  );
}
