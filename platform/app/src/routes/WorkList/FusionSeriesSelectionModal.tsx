import React, { useState } from 'react';
import { Button, ButtonEnums } from '@ohif/ui';

interface Series {
  seriesInstanceUid: string;
  description: string;
  modality: string;
  seriesNumber?: string;
}

interface FusionSeriesSelectionModalProps {
  ctStudyInstanceUID: string;
  mrStudyInstanceUID: string;
  ctSeries: Series[];
  mrSeries: Series[];
  onFusion: (ctSeriesInstanceUID: string, mrSeriesInstanceUID: string) => void;
  onClose: () => void;
}

const FusionSeriesSelectionModal: React.FC<FusionSeriesSelectionModalProps> = ({
  ctStudyInstanceUID,
  mrStudyInstanceUID,
  ctSeries,
  mrSeries,
  onFusion,
  onClose,
}) => {
  const [selectedCTSeries, setSelectedCTSeries] = useState<string>('');
  const [selectedMRSeries, setSelectedMRSeries] = useState<string>('');

  const isFusionEnabled = selectedCTSeries && selectedMRSeries;

  const handleFusion = () => {
    if (isFusionEnabled) {
      onFusion(selectedCTSeries, selectedMRSeries);
    }
  };

  return (
    <div className="flex flex-col bg-black text-white p-6 min-w-[800px] max-w-[1000px]">
      <div className="flex gap-8 mb-6">
        {/* MR Series List (Left) */}
        <div className="flex-1">
          <h3 className="text-lg font-medium mb-4">MR Series</h3>
          <div className="border border-secondary-light rounded p-4 max-h-[400px] overflow-y-auto">
            {mrSeries.length === 0 ? (
              <p className="text-secondary-light">No MR series available</p>
            ) : (
              <div className="space-y-2">
                {mrSeries.map(series => (
                  <label
                    key={series.seriesInstanceUid}
                    className="flex items-start gap-3 p-2 hover:bg-secondary-dark rounded cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="mrSeries"
                      value={series.seriesInstanceUid}
                      checked={selectedMRSeries === series.seriesInstanceUid}
                      onChange={e => setSelectedMRSeries(e.target.value)}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium">
                        {series.description || '(No description)'}
                      </div>
                      {series.seriesNumber && (
                        <div className="text-sm text-secondary-light">
                          Series: {series.seriesNumber}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* CT Series List (Right) */}
        <div className="flex-1">
          <h3 className="text-lg font-medium mb-4">CT Series</h3>
          <div className="border border-secondary-light rounded p-4 max-h-[400px] overflow-y-auto">
            {ctSeries.length === 0 ? (
              <p className="text-secondary-light">No CT series available</p>
            ) : (
              <div className="space-y-2">
                {ctSeries.map(series => (
                  <label
                    key={series.seriesInstanceUid}
                    className="flex items-start gap-3 p-2 hover:bg-secondary-dark rounded cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="ctSeries"
                      value={series.seriesInstanceUid}
                      checked={selectedCTSeries === series.seriesInstanceUid}
                      onChange={e => setSelectedCTSeries(e.target.value)}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium">
                        {series.description || '(No description)'}
                      </div>
                      {series.seriesNumber && (
                        <div className="text-sm text-secondary-light">
                          Series: {series.seriesNumber}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Fusion Button */}
      <div className="flex justify-end gap-4 pt-4 border-t border-secondary-light">
        <Button
          type={ButtonEnums.type.secondary}
          size={ButtonEnums.size.medium}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type={ButtonEnums.type.primary}
          size={ButtonEnums.size.medium}
          onClick={handleFusion}
          disabled={!isFusionEnabled}
        >
          Fusion
        </Button>
      </div>
    </div>
  );
};

export default FusionSeriesSelectionModal;
