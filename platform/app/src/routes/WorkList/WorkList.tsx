import React, { useState, useEffect, useMemo } from 'react';
import classnames from 'classnames';
import PropTypes from 'prop-types';
import { Link, useNavigate } from 'react-router-dom';
import moment from 'moment';
import qs from 'query-string';
import isEqual from 'lodash.isequal';
import { useTranslation } from 'react-i18next';
//
import filtersMeta from './filtersMeta.js';
import { useAppConfig } from '@state';
import { useDebounce, useSearchParams } from '../../hooks';
import { utils, Types as coreTypes } from '@ohif/core';
import { toast } from '@ohif/ui-next';

import {
  StudyListExpandedRow,
  EmptyStudies,
  StudyListTable,
  StudyListPagination,
  StudyListFilter,
  Button,
  ButtonEnums,
} from '@ohif/ui';

import {
  Header,
  Icons,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Clipboard,
  useModal,
  useSessionStorage,
  Onboarding,
  ScrollArea,
  InvestigationalUseDialog,
} from '@ohif/ui-next';

import { Types } from '@ohif/ui';

import { preserveQueryParameters, preserveQueryStrings } from '../../utils/preserveQueryParameters';
import { buildFunctionUrl } from '../../utils/buildFunctionUrl';
import FusionSeriesSelectionModal from './FusionSeriesSelectionModal';

const PatientInfoVisibility = Types.PatientInfoVisibility;

const { sortBySeriesDate } = utils;

const seriesInStudiesMap = new Map();

function getAuthHeader(dataSource) {
  const bearer = dataSource?.retrieve?.customClient?.headers?.Authorization;
  return bearer ? { Authorization: bearer } : {};
}

/**
 * TODO:
 * - debounce `setFilterValues` (150ms?)
 */
function WorkList({
  data: studies,
  dataTotal: studiesTotal,
  isLoadingData,
  dataSource,
  hotkeysManager,
  dataPath,
  onRefresh,
  servicesManager,
}: withAppTypes) {
  const { show, hide } = useModal();
  const { t } = useTranslation();
  // ~ Modes
  const [appConfig] = useAppConfig();
  // ~ Filters
  const searchParams = useSearchParams();
  const navigate = useNavigate();
  const STUDIES_LIMIT = 101;
  const queryFilterValues = _getQueryFilterValues(searchParams);
  const config = dataSource.getConfig();
  const [sessionQueryFilterValues, updateSessionQueryFilterValues] = useSessionStorage({
    key: 'queryFilterValues',
    defaultValue: queryFilterValues,
    // ToDo: useSessionStorage currently uses an unload listener to clear the filters from session storage
    // so on systems that do not support unload events a user will NOT be able to alter any existing filter
    // in the URL, load the page and have it apply.
    clearOnUnload: true,
  });
  const [filterValues, _setFilterValues] = useState({
    ...defaultFilterValues,
    ...sessionQueryFilterValues,
  });

  const debouncedFilterValues = useDebounce(filterValues, 200);
  const { resultsPerPage, pageNumber, sortBy, sortDirection } = filterValues;

  /*
   * The default sort value keep the filters synchronized with runtime conditional sorting
   * Only applied if no other sorting is specified and there are less than 101 studies
   */

  const canSort = studiesTotal < STUDIES_LIMIT;
  const shouldUseDefaultSort = sortBy === '' || !sortBy;
  const sortModifier = sortDirection === 'descending' ? 1 : -1;
  const defaultSortValues =
    shouldUseDefaultSort && canSort ? { sortBy: 'studyDate', sortDirection: 'ascending' } : {};
  const { customizationService } = servicesManager.services;

  const sortedStudies = useMemo(() => {
    if (!canSort) {
      return studies;
    }

    return [...studies].sort((s1, s2) => {
      if (shouldUseDefaultSort) {
        const ascendingSortModifier = -1;
        return _sortStringDates(s1, s2, ascendingSortModifier);
      }

      const s1Prop = s1[sortBy];
      const s2Prop = s2[sortBy];

      if (typeof s1Prop === 'string' && typeof s2Prop === 'string') {
        return s1Prop.localeCompare(s2Prop) * sortModifier;
      } else if (typeof s1Prop === 'number' && typeof s2Prop === 'number') {
        return (s1Prop > s2Prop ? 1 : -1) * sortModifier;
      } else if (!s1Prop && s2Prop) {
        return -1 * sortModifier;
      } else if (!s2Prop && s1Prop) {
        return 1 * sortModifier;
      } else if (sortBy === 'studyDate') {
        return _sortStringDates(s1, s2, sortModifier);
      }

      return 0;
    });
  }, [canSort, studies, shouldUseDefaultSort, sortBy, sortModifier]);

  // ~ Rows & Studies
  const [expandedRows, setExpandedRows] = useState([]);
  const [studiesWithSeriesData, setStudiesWithSeriesData] = useState([]);
  const numOfStudies = studiesTotal;

  // ~ Fusion Study Selection
  const [selectedCTStudy, setSelectedCTStudy] = useState<string | null>(null);
  const [selectedMRStudy, setSelectedMRStudy] = useState<string | null>(null);
  const querying = useMemo(() => {
    return isLoadingData || expandedRows.length > 0;
  }, [isLoadingData, expandedRows]);

  const setFilterValues = val => {
    if (filterValues.pageNumber === val.pageNumber) {
      val.pageNumber = 1;
    }
    _setFilterValues(val);
    updateSessionQueryFilterValues(val);
    setExpandedRows([]);
  };

  const onPageNumberChange = newPageNumber => {
    const oldPageNumber = filterValues.pageNumber;
    const rollingPageNumberMod = Math.floor(101 / filterValues.resultsPerPage);
    const rollingPageNumber = oldPageNumber % rollingPageNumberMod;
    const isNextPage = newPageNumber > oldPageNumber;
    const hasNextPage = Math.max(rollingPageNumber, 1) * resultsPerPage < numOfStudies;

    if (isNextPage && !hasNextPage) {
      return;
    }

    setFilterValues({ ...filterValues, pageNumber: newPageNumber });
  };

  const onResultsPerPageChange = newResultsPerPage => {
    setFilterValues({
      ...filterValues,
      pageNumber: 1,
      resultsPerPage: Number(newResultsPerPage),
    });
  };

  const handleDeleteStudy = async studyUID => {
    if (!window.confirm(`Delete study ${studyUID}?`)) {
      return;
    }
    try {
      await dataSource.retrieve.customClient.deleteStudy(studyUID);
      onRefresh?.();
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete study.');
    }
  };

  const handleDownloadStudy = async (studyUID: string) => {
    try {
      const res = await fetch(
        `https://${config.pythonFunctionName}.azurewebsites.net/api/downloaddicom?studyId=${encodeURIComponent(studyUID)}`,
        {
          credentials: 'include',
          headers: {
            ...getAuthHeader(dataSource),
          },
        }
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const sasUrl = (await res.text()).trim();
      window.open(sasUrl, '_blank');
    } catch (err) {
      console.error(err);
      toast.error('Failed to download study.');
    }
  };

  // Fetch series for selected studies if not already fetched
  useEffect(() => {
    const fetchSeriesForSelectedStudies = async () => {
      const studiesToFetch = [selectedCTStudy, selectedMRStudy].filter(Boolean);

      for (const studyInstanceUid of studiesToFetch) {
        if (!seriesInStudiesMap.has(studyInstanceUid) && !studiesWithSeriesData.includes(studyInstanceUid)) {
          try {
            const series = await dataSource.query.series.search(studyInstanceUid);
            seriesInStudiesMap.set(studyInstanceUid, sortBySeriesDate(series));
            setStudiesWithSeriesData(prev => [...prev, studyInstanceUid]);
          } catch (ex) {
            console.warn('Failed to fetch series for study:', studyInstanceUid, ex);
          }
        }
      }
    };

    if (selectedCTStudy || selectedMRStudy) {
      fetchSeriesForSelectedStudies();
    }
  }, [selectedCTStudy, selectedMRStudy, dataSource, studiesWithSeriesData]);

  // Handle Fusion button click
  const handleFusionClick = async () => {
    if (!selectedCTStudy || !selectedMRStudy) {
      return;
    }

    // Get series for both studies
    const ctSeries = seriesInStudiesMap.get(selectedCTStudy) || [];
    const mrSeries = seriesInStudiesMap.get(selectedMRStudy) || [];

    // Filter CT and MR series (excluding MR with Fusion in description)
    const filteredCTSeries = ctSeries.filter(s => {
      const modality = (s.modality || s.Modality || '').trim();
      return modality === 'CT';
    });

    const filteredMRSeries = mrSeries.filter(s => {
      const modality = (s.modality || s.Modality || '').trim();
      const description = (s.description || '').trim();
      return modality === 'MR' && !description.toLowerCase().includes('fusion');
    });

    // Check if we need to show the modal (more than one CT or MR series)
    if (filteredCTSeries.length > 1 || filteredMRSeries.length > 1) {
      // Show modal for series selection
      show({
        content: FusionSeriesSelectionModal,
        title: 'Select Series for Fusion',
        containerClassName: 'max-w-6xl',
        contentProps: {
          ctStudyInstanceUID: selectedCTStudy,
          mrStudyInstanceUID: selectedMRStudy,
          ctSeries: filteredCTSeries.map(s => ({
            seriesInstanceUid: s.seriesInstanceUid,
            description: s.description || '',
            modality: s.modality || s.Modality || '',
            seriesNumber: s.seriesNumber,
          })),
          mrSeries: filteredMRSeries.map(s => ({
            seriesInstanceUid: s.seriesInstanceUid,
            description: s.description || '',
            modality: s.modality || s.Modality || '',
            seriesNumber: s.seriesNumber,
          })),
          onFusion: handleFusionRequest,
          onClose: hide,
        },
      });
    } else if (filteredCTSeries.length === 1 && filteredMRSeries.length === 1) {
      // Direct fusion with single series each
      handleFusionRequest(
        filteredCTSeries[0].seriesInstanceUid,
        filteredMRSeries[0].seriesInstanceUid
      );
    } else {
      toast.error('No valid CT or MR series found for fusion.');
    }
  };

  // Handle fusion API request
  const handleFusionRequest = async (ctSeriesInstanceUID: string, mrSeriesInstanceUID: string) => {
    if (!selectedCTStudy || !selectedMRStudy) {
      return;
    }

    // Get series descriptions for notification
    const ctSeries = seriesInStudiesMap.get(selectedCTStudy) || [];
    const mrSeries = seriesInStudiesMap.get(selectedMRStudy) || [];

    const ctSeriesData = ctSeries.find(s => s.seriesInstanceUid === ctSeriesInstanceUID);
    const mrSeriesData = mrSeries.find(s => s.seriesInstanceUid === mrSeriesInstanceUID);

    const ctDescription = ctSeriesData?.description || 'CT series';
    const mrDescription = mrSeriesData?.description || 'MR series';

    // Close modal if open
    hide();

    // Show starting notification
    toast.info(`Fusion of CT ${ctDescription} and MR ${mrDescription} is started.`);

    try {
      const endpoint = buildFunctionUrl(config, 'fusion/ct-mr');
      const payload = {
        ctStudyInstanceUID: selectedCTStudy,
        ctSeriesInstanceUID: ctSeriesInstanceUID,
        mrStudyInstanceUID: selectedMRStudy,
        mrSeriesInstanceUID: mrSeriesInstanceUID,
        mode: 'rigid',
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(dataSource),
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch (e) {
          errorText = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorText || `HTTP ${response.status}: ${response.statusText}`);
      }

      // Try to parse JSON, but handle non-JSON responses
      try {
        const result = await response.json();
        toast.success(`Fusion completed successfully.`);
      } catch (e) {
        // If response is not JSON, still consider it successful if status is OK
        toast.success(`Fusion completed successfully.`);
      }
    } catch (error) {
      console.error('Fusion request failed:', error);
      toast.error(`Fusion failed: ${error.message || 'Unknown error'}`);
    }
  };

  // Set body style
  useEffect(() => {
    document.body.classList.add('bg-black');
    return () => {
      document.body.classList.remove('bg-black');
    };
  }, []);

  // Sync URL query parameters with filters
  useEffect(() => {
    if (!debouncedFilterValues) {
      return;
    }

    const queryString = {};
    Object.keys(defaultFilterValues).forEach(key => {
      const defaultValue = defaultFilterValues[key];
      const currValue = debouncedFilterValues[key];

      // TODO: nesting/recursion?
      if (key === 'studyDate') {
        if (currValue.startDate && defaultValue.startDate !== currValue.startDate) {
          queryString.startDate = currValue.startDate;
        }
        if (currValue.endDate && defaultValue.endDate !== currValue.endDate) {
          queryString.endDate = currValue.endDate;
        }
      } else if (key === 'modalities' && currValue.length) {
        queryString.modalities = currValue.join(',');
      } else if (currValue !== defaultValue) {
        queryString[key] = currValue;
      }
    });

    preserveQueryStrings(queryString);

    const search = qs.stringify(queryString, {
      skipNull: true,
      skipEmptyString: true,
    });
    navigate({
      pathname: '/',
      search: search ? `?${search}` : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFilterValues]);

  // Query for series information
  useEffect(() => {
    const fetchSeries = async studyInstanceUid => {
      try {
        const series = await dataSource.query.series.search(studyInstanceUid);
        seriesInStudiesMap.set(studyInstanceUid, sortBySeriesDate(series));
        setStudiesWithSeriesData([...studiesWithSeriesData, studyInstanceUid]);
      } catch (ex) {
        // TODO: UI Notification Service
        console.warn(ex);
      }
    };

    // TODO: WHY WOULD YOU USE AN INDEX OF 1?!
    // Note: expanded rows index begins at 1
    for (let z = 0; z < expandedRows.length; z++) {
      const expandedRowIndex = expandedRows[z] - 1;
      const studyInstanceUid = sortedStudies[expandedRowIndex].studyInstanceUid;

      if (studiesWithSeriesData.includes(studyInstanceUid)) {
        continue;
      }

      fetchSeries(studyInstanceUid);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedRows, studies]);

  const isFiltering = (filterValues, defaultFilterValues) => {
    return !isEqual(filterValues, defaultFilterValues);
  };

  // Helper functions for modality checking
  const hasModality = (modalities: string, modality: string): boolean => {
    if (!modalities) return false;
    // Modalities can be separated by '/' or '\'
    const modalityList = modalities.split(/[/\\]/).map(m => m.trim());
    return modalityList.includes(modality);
  };

  // Check if study has CT or MR by checking both study-level modalities and series data
  const studyHasCTOrMR = (studyInstanceUid: string, modalities: string): { hasCT: boolean; hasMR: boolean } => {
    let hasCT = false;
    let hasMR = false;

    // First check study-level modalities
    if (modalities) {
      hasCT = hasModality(modalities, 'CT');
      hasMR = hasModality(modalities, 'MR');
    }

    // Check series data if available (series data is more reliable than study-level modalities)
    // Always check series data if it's available, as it's more accurate
    if (seriesInStudiesMap.has(studyInstanceUid)) {
      const series = seriesInStudiesMap.get(studyInstanceUid);
      if (series && Array.isArray(series)) {
        // Reset hasCT and hasMR to check from series data
        hasCT = false;
        hasMR = false;
        for (const s of series) {
          const seriesModality = (s.modality || s.Modality || '').trim();
          const seriesDescription = (s.description || '').trim();

          if (seriesModality === 'CT') {
            hasCT = true;
          } else if (seriesModality === 'MR') {
            // Ignore MR modalities that have "Fusion" in description
            if (!seriesDescription.toLowerCase().includes('fusion')) {
              hasMR = true;
            }
          }
          // If we found both, we can break early
          if (hasCT && hasMR) break;
        }
      }
    } else {
      // If no series data available, we still need to check study-level modalities
      // but we can't check descriptions, so we'll use the study-level check
      // However, if we have series data later, it will override this
    }

    return { hasCT, hasMR };
  };

  const hasCT = (modalities: string): boolean => hasModality(modalities, 'CT');
  const hasMR = (modalities: string): boolean => hasModality(modalities, 'MR');

  const hasCTOrMR = (modalities: string): boolean => {
    return hasCT(modalities) || hasMR(modalities);
  };

  // Handle study checkbox selection
  const handleStudySelection = (studyInstanceUid: string, modalities: string) => {
    const { hasCT: isCT, hasMR: isMR } = studyHasCTOrMR(studyInstanceUid, modalities);

    if (isCT) {
      if (selectedCTStudy === studyInstanceUid) {
        // Unselect CT
        setSelectedCTStudy(null);
      } else {
        // Select CT
        setSelectedCTStudy(studyInstanceUid);
      }
    } else if (isMR) {
      if (selectedMRStudy === studyInstanceUid) {
        // Unselect MR
        setSelectedMRStudy(null);
      } else {
        // Select MR
        setSelectedMRStudy(studyInstanceUid);
      }
    }
  };

  // Determine if checkbox should be shown for a study (always show if has CT or MR)
  const shouldShowCheckbox = (studyInstanceUid: string, modalities: string): boolean => {
    const { hasCT, hasMR } = studyHasCTOrMR(studyInstanceUid, modalities);
    return hasCT || hasMR;
  };

  // Determine if checkbox should be enabled (selectable)
  const isCheckboxEnabled = (studyInstanceUid: string, modalities: string): boolean => {
    // Always enable if the checkbox is already checked (selected)
    const isChecked = isCheckboxChecked(studyInstanceUid, modalities);
    if (isChecked) {
      return true;
    }

    const { hasCT: isCT, hasMR: isMR } = studyHasCTOrMR(studyInstanceUid, modalities);

    // If both studies are selected, enable checkboxes only on the selected studies
    if (selectedCTStudy && selectedMRStudy) {
      return studyInstanceUid === selectedCTStudy || studyInstanceUid === selectedMRStudy;
    }

    // If CT is selected, enable checkboxes only on MR studies
    if (selectedCTStudy) {
      return isMR;
    }

    // If MR is selected, enable checkboxes only on CT studies
    if (selectedMRStudy) {
      return isCT;
    }

    // If nothing is selected, enable checkboxes on all CT/MR studies
    return true;
  };

  // Determine if checkbox should be checked
  const isCheckboxChecked = (studyInstanceUid: string, modalities: string): boolean => {
    const { hasCT: isCT, hasMR: isMR } = studyHasCTOrMR(studyInstanceUid, modalities);

    if (isCT && selectedCTStudy === studyInstanceUid) {
      return true;
    }
    if (isMR && selectedMRStudy === studyInstanceUid) {
      return true;
    }
    return false;
  };

  const rollingPageNumberMod = Math.floor(101 / resultsPerPage);
  const rollingPageNumber = (pageNumber - 1) % rollingPageNumberMod;
  const offset = resultsPerPage * rollingPageNumber;
  const offsetAndTake = offset + resultsPerPage;
  const tableDataSource = sortedStudies.map((study, key) => {
    const rowKey = key + 1;
    const isExpanded = expandedRows.some(k => k === rowKey);
    const {
      studyInstanceUid,
      accession,
      modalities,
      instances,
      description,
      mrn,
      patientName,
      date,
      time,
    } = study;
    const studyDate =
      date &&
      moment(date, ['YYYYMMDD', 'YYYY.MM.DD'], true).isValid() &&
      moment(date, ['YYYYMMDD', 'YYYY.MM.DD']).format(t('Common:localDateFormat', 'MMM-DD-YYYY'));
    const studyTime =
      time &&
      moment(time, ['HH', 'HHmm', 'HHmmss', 'HHmmss.SSS']).isValid() &&
      moment(time, ['HH', 'HHmm', 'HHmmss', 'HHmmss.SSS']).format(
        t('Common:localTimeFormat', 'hh:mm A')
      );

    const makeCopyTooltipCell = textValue => {
      if (!textValue) {
        return '';
      }
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-pointer truncate">{textValue}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex items-center justify-between gap-2">
              {textValue}
              <Clipboard>{textValue}</Clipboard>
            </div>
          </TooltipContent>
        </Tooltip>
      );
    };

    const showCheckbox = shouldShowCheckbox(studyInstanceUid, modalities);
    const isChecked = isCheckboxChecked(studyInstanceUid, modalities);
    const checkboxEnabled = showCheckbox ? isCheckboxEnabled(studyInstanceUid, modalities) : false;

    return {
      dataCY: `studyRow-${studyInstanceUid}`,
      clickableCY: studyInstanceUid,
      studyUID: studyInstanceUid,
      onDeleteStudy: handleDeleteStudy,
      onDownloadStudy: handleDownloadStudy,
      showCheckbox,
      isChecked,
      isCheckboxEnabled: checkboxEnabled,
      onCheckboxChange: () => handleStudySelection(studyInstanceUid, modalities),
      modalities,
      row: [
        {
          key: 'patientName',
          content: patientName ? makeCopyTooltipCell(patientName) : null,
          gridCol: 4,
        },
        {
          key: 'mrn',
          content: makeCopyTooltipCell(mrn),
          gridCol: 3,
        },
        {
          key: 'studyDate',
          content: (
            <>
              {studyDate && <span className="mr-4">{studyDate}</span>}
              {studyTime && <span>{studyTime}</span>}
            </>
          ),
          title: `${studyDate || ''} ${studyTime || ''}`,
          gridCol: 5,
        },
        {
          key: 'description',
          content: makeCopyTooltipCell(description),
          gridCol: 4,
        },
        {
          key: 'modality',
          content: modalities,
          title: modalities,
          gridCol: 3,
        },
        {
          key: 'accession',
          content: makeCopyTooltipCell(accession),
          gridCol: 3,
        },
        {
          key: 'instances',
          content: (
            <>
              <Icons.GroupLayers
                className={classnames('mr-2 inline-flex w-4', {
                  'text-primary': isExpanded,
                  'text-secondary-light': !isExpanded,
                })}
              />
              {instances}
            </>
          ),
          title: (instances || 0).toString(),
          gridCol: 2,
        },
      ],
      // Todo: This is actually running for all rows, even if they are
      // not clicked on.
      expandedContent: (
        <StudyListExpandedRow
          seriesTableColumns={{
            description: t('StudyList:Description'),
            seriesNumber: t('StudyList:Series'),
            modality: t('StudyList:Modality'),
            instances: t('StudyList:Instances'),
          }}
          seriesTableDataSource={
            seriesInStudiesMap.has(studyInstanceUid)
              ? seriesInStudiesMap.get(studyInstanceUid).map(s => {
                  return {
                    description: s.description || '(empty)',
                    seriesNumber: s.seriesNumber ?? '',
                    modality: s.modality || '',
                    instances: s.numSeriesInstances || '',
                  };
                })
              : []
          }
        >
          <div className="flex flex-row gap-2">
            {(appConfig.groupEnabledModesFirst
              ? appConfig.loadedModes.sort((a, b) => {
                  const isValidA = a.isValidMode({
                    modalities: modalities.replaceAll('/', '\\'),
                    study,
                  }).valid;
                  const isValidB = b.isValidMode({
                    modalities: modalities.replaceAll('/', '\\'),
                    study,
                  }).valid;

                  return isValidB - isValidA;
                })
              : appConfig.loadedModes
            ).filter(mode => {
                // Only show "Basic Viewer" and "Segmentation" buttons
                const allowedModes = ['Basic Viewer', 'Segmentation'];
                return mode.displayName && allowedModes.includes(mode.displayName);
              }).map((mode, i) => {
              if (mode.hide) {
                // Hide this mode from display
                return null;
              }
              const modalitiesToCheck = modalities.replaceAll('/', '\\');

              const { valid: isValidMode, description: invalidModeDescription } = mode.isValidMode({
                modalities: modalitiesToCheck,
                study,
              });
              if (isValidMode === null) {
                // Hide this as a computed result.
                return null;
              }

              // TODO: Modes need a default/target route? We mostly support a single one for now.
              // We should also be using the route path, but currently are not
              // mode.routeName
              // mode.routes[x].path
              // Don't specify default data source, and it should just be picked up... (this may not currently be the case)
              // How do we know which params to pass? Today, it's just StudyInstanceUIDs and configUrl if exists
              const query = new URLSearchParams();
              if (filterValues.configUrl) {
                query.append('configUrl', filterValues.configUrl);
              }
              query.append('StudyInstanceUIDs', studyInstanceUid);
              preserveQueryParameters(query);

              return (
                mode.displayName && (
                  <Link
                    className={isValidMode ? '' : 'cursor-not-allowed'}
                    key={i}
                    to={`${mode.routeName}${dataPath || ''}?${query.toString()}`}
                    onClick={event => {
                      // In case any event bubbles up for an invalid mode, prevent the navigation.
                      // For example, the event bubbles up when the icon embedded in the disabled button is clicked.
                      if (!isValidMode) {
                        event.preventDefault();
                      }
                    }}
                    // to={`${mode.routeName}/dicomweb?StudyInstanceUIDs=${studyInstanceUid}`}
                  >
                    {/* TODO revisit the completely rounded style of buttons used for launching a mode from the worklist later */}
                    <Button
                      type={ButtonEnums.type.primary}
                      size={ButtonEnums.size.smallTall}
                      disabled={!isValidMode}
                      startIconTooltip={
                        !isValidMode ? (
                          <div className="font-inter flex w-[206px] whitespace-normal text-left text-xs font-normal text-white">
                            {invalidModeDescription}
                          </div>
                        ) : null
                      }
                      startIcon={
                        isValidMode ? (
                          <Icons.LaunchArrow className="!h-[20px] !w-[20px] text-black" />
                        ) : (
                          <Icons.LaunchInfo className="!h-[20px] !w-[20px] text-black" />
                        )
                      }
                      onClick={() => {}}
                      dataCY={`mode-${mode.routeName}-${studyInstanceUid}`}
                      className={!isValidMode && 'bg-[#166b2b]'}
                    >
                      {mode.displayName}
                    </Button>
                  </Link>
                )
              );
            })}
          </div>
        </StudyListExpandedRow>
      ),
      onClickRow: () =>
        setExpandedRows(s => (isExpanded ? s.filter(n => rowKey !== n) : [...s, rowKey])),
      isExpanded,
    };
  });

  const hasStudies = numOfStudies > 0;

  const AboutModal = customizationService.getCustomization(
    'ohif.aboutModal'
  ) as coreTypes.MenuComponentCustomization;
  const UserPreferencesModal = customizationService.getCustomization(
    'ohif.userPreferencesModal'
  ) as coreTypes.MenuComponentCustomization;

  const menuOptions = [
    {
      title: AboutModal?.menuTitle ?? t('Header:About'),
      icon: 'info',
      onClick: () =>
        show({
          content: AboutModal,
          title: AboutModal?.title ?? t('AboutModal:About OHIF Viewer'),
          containerClassName: AboutModal?.containerClassName ?? 'max-w-md',
        }),
    },
    {
      title: UserPreferencesModal.menuTitle ?? t('Header:Preferences'),
      icon: 'settings',
      onClick: () =>
        show({
          content: UserPreferencesModal as React.ComponentType,
          title: UserPreferencesModal.title ?? t('UserPreferencesModal:User preferences'),
          containerClassName:
            UserPreferencesModal?.containerClassName ?? 'flex max-w-4xl p-6 flex-col',
        }),
    },
  ];

  if (appConfig.oidc) {
    menuOptions.push({
      icon: 'power-off',
      title: t('Header:Logout'),
      onClick: () => {
        navigate(`/logout?redirect_uri=${encodeURIComponent(window.location.href)}`);
      },
    });
  }

  const LoadingIndicatorProgress = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  );
  const DicomUploadComponent = customizationService.getCustomization('dicomUploadComponent');

  const uploadProps =
    DicomUploadComponent && dataSource.getConfig()?.dicomUploadEnabled
      ? {
          title: 'Upload files',
          containerClassName: DicomUploadComponent?.containerClassName,
          closeButton: true,
          shouldCloseOnEsc: false,
          shouldCloseOnOverlayClick: false,
          content: () => (
            <DicomUploadComponent
              dataSource={dataSource}
              onComplete={() => {
                hide();
                onRefresh();
              }}
              onStarted={() => {
                show({
                  ...uploadProps,
                  // when upload starts, hide the default close button as closing the dialogue must be handled by the upload dialogue itself
                  closeButton: false,
                });
              }}
            />
          ),
        }
      : undefined;

  const dataSourceConfigurationComponent = customizationService.getCustomization(
    'ohif.dataSourceConfigurationComponent'
  );

  return (
    <div className="flex h-screen flex-col bg-black">
      <Header
        isSticky
        menuOptions={menuOptions}
        isReturnEnabled={false}
        WhiteLabeling={appConfig.whiteLabeling}
        showPatientInfo={PatientInfoVisibility.DISABLED}
      />
      <Onboarding />
      <InvestigationalUseDialog dialogConfiguration={appConfig?.investigationalUseDialog} />
      <div className="flex h-full flex-col overflow-y-auto">
        <ScrollArea>
          <div className="flex grow flex-col">
            <StudyListFilter
              numOfStudies={pageNumber * resultsPerPage > 100 ? 101 : numOfStudies}
              filtersMeta={filtersMeta}
              filterValues={{ ...filterValues, ...defaultSortValues }}
              onChange={setFilterValues}
              clearFilters={() => setFilterValues(defaultFilterValues)}
              isFiltering={isFiltering(filterValues, defaultFilterValues)}
              onUploadClick={uploadProps ? () => show(uploadProps) : undefined}
              getDataSourceConfigurationComponent={
                dataSourceConfigurationComponent
                  ? () => dataSourceConfigurationComponent()
                  : undefined
              }
            />
          </div>
          {hasStudies ? (
            <div className="flex grow flex-col">
              {selectedCTStudy && selectedMRStudy && (
                <div className="container m-auto mb-4 flex justify-center">
                  <Button
                    type={ButtonEnums.type.primary}
                    size={ButtonEnums.size.medium}
                    onClick={handleFusionClick}
                    dataCY="fusion-button"
                    className="px-8 py-2"
                  >
                    Fusion
                  </Button>
                </div>
              )}
              <StudyListTable
                tableDataSource={tableDataSource.slice(offset, offsetAndTake)}
                numOfStudies={numOfStudies}
                querying={querying}
                filtersMeta={filtersMeta}
              />
              <div className="grow">
                <StudyListPagination
                  onChangePage={onPageNumberChange}
                  onChangePerPage={onResultsPerPageChange}
                  currentPage={pageNumber}
                  perPage={resultsPerPage}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center pt-48">
              {appConfig.showLoadingIndicator && isLoadingData ? (
                <LoadingIndicatorProgress className={'h-full w-full bg-black'} />
              ) : (
                <EmptyStudies />
              )}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

WorkList.propTypes = {
  data: PropTypes.array.isRequired,
  dataSource: PropTypes.shape({
    query: PropTypes.object.isRequired,
    getConfig: PropTypes.func,
  }).isRequired,
  isLoadingData: PropTypes.bool.isRequired,
  servicesManager: PropTypes.object.isRequired,
};

const defaultFilterValues = {
  patientName: '',
  mrn: '',
  studyDate: {
    startDate: null,
    endDate: null,
  },
  description: '',
  modalities: [],
  accession: '',
  sortBy: '',
  sortDirection: 'none',
  pageNumber: 1,
  resultsPerPage: 25,
  datasources: '',
};

function _tryParseInt(str, defaultValue) {
  let retValue = defaultValue;
  if (str && str.length > 0) {
    if (!isNaN(str)) {
      retValue = parseInt(str);
    }
  }
  return retValue;
}

function _getQueryFilterValues(params) {
  const newParams = new URLSearchParams();
  for (const [key, value] of params) {
    newParams.set(key.toLowerCase(), value);
  }
  params = newParams;

  const queryFilterValues = {
    patientName: params.get('patientname'),
    mrn: params.get('mrn'),
    studyDate: {
      startDate: params.get('startdate') || null,
      endDate: params.get('enddate') || null,
    },
    description: params.get('description'),
    modalities: params.get('modalities') ? params.get('modalities').split(',') : [],
    accession: params.get('accession'),
    sortBy: params.get('sortby'),
    sortDirection: params.get('sortdirection'),
    pageNumber: _tryParseInt(params.get('pagenumber'), undefined),
    resultsPerPage: _tryParseInt(params.get('resultsperpage'), undefined),
    datasources: params.get('datasources'),
    configUrl: params.get('configurl'),
  };

  // Delete null/undefined keys
  Object.keys(queryFilterValues).forEach(
    key => queryFilterValues[key] == null && delete queryFilterValues[key]
  );

  return queryFilterValues;
}

function _sortStringDates(s1, s2, sortModifier) {
  // TODO: Delimiters are non-standard. Should we support them?
  const s1Date = moment(s1.date, ['YYYYMMDD', 'YYYY.MM.DD'], true);
  const s2Date = moment(s2.date, ['YYYYMMDD', 'YYYY.MM.DD'], true);

  if (s1Date.isValid() && s2Date.isValid()) {
    return (s1Date.toISOString() > s2Date.toISOString() ? 1 : -1) * sortModifier;
  } else if (s1Date.isValid()) {
    return sortModifier;
  } else if (s2Date.isValid()) {
    return -1 * sortModifier;
  }
}



export default WorkList;
