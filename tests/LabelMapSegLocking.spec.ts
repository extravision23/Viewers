import { checkForScreenshot, expect, screenShotPaths, test, visitStudy } from './utils';
import { press } from './utils/keyboardUtils';

test.beforeEach(async ({ page }) => {
  const studyInstanceUID = '1.3.6.1.4.1.14519.5.2.1.256467663913010332776401703474716742458';
  const mode = 'segmentation';
  await visitStudy(page, studyInstanceUID, mode, 2000);
});

test('should prevent editing of label map segmentations when panelSegmentation.disableEditing is true', async ({
  page,
  DOMOverlayPageObject,
  leftPanelPageObject,
  rightPanelPageObject,
  viewportPageObject,
}) => {
  // disable editing of segmentations via the customization service
  await page.evaluate(() => {
    window.services.customizationService.setGlobalCustomization(
      'panelSegmentation.disableEditing',
      {
        $set: true,
      }
    );
  });
  await rightPanelPageObject.labelMapSegmentationPanel.select();

  await leftPanelPageObject.loadSeriesByModality('SEG');
  // Wait for the segmentation to be loaded.
  await page.waitForTimeout(5000);

  await DOMOverlayPageObject.viewport.segmentationHydration.yes.click();

  // Wait for the segmentation to hydrate.
  await page.waitForTimeout(5000);

  // navigate to the 12th image and ensure the correct overlay is displayed
  await press({ page, key: 'ArrowDown', nTimes: 11 });

  await checkForScreenshot(page, page, screenShotPaths.labelMapSegLocking.globalLockedSegPreEdit);

  // Attempt to erase the segmentations.
  await rightPanelPageObject.labelMapSegmentationPanel.tools.eraser.click();

  // Use the largest eraser radius to help ensure the entire image is erased.
  await rightPanelPageObject.labelMapSegmentationPanel.tools.eraser.setRadius(1000);

  // Attempt to erase the segmentations by dragging the eraser tool across the image several times.
  const defaultViewport = await viewportPageObject.getById('default');
  await defaultViewport.normalizedDragAt({
    start: { x: 0.01, y: 0.25 },
    end: { x: 1.0, y: 0.25 },
  });
  await defaultViewport.normalizedDragAt({
    start: { x: 0.01, y: 0.5 },
    end: { x: 1.0, y: 0.5 },
  });
  await defaultViewport.normalizedDragAt({
    start: { x: 0.01, y: 0.75 },
    end: { x: 1.0, y: 0.75 },
  });

  await checkForScreenshot(page, page, screenShotPaths.labelMapSegLocking.globalLockedSegPostEdit);
});

test('should allow editing of label map segmentations when panelSegmentation.disableEditing is false', async ({
  page,
  DOMOverlayPageObject,
  leftPanelPageObject,
  rightPanelPageObject,
  viewportPageObject,
}) => {
  // disable editing of segmentations via the customization service
  await page.evaluate(() => {
    window.services.customizationService.setGlobalCustomization(
      'panelSegmentation.disableEditing',
      {
        $set: false,
      }
    );
  });

  await rightPanelPageObject.labelMapSegmentationPanel.select();

  await leftPanelPageObject.loadSeriesByModality('SEG');
  // Wait for the segmentation to be loaded.
  await page.waitForTimeout(5000);

  await DOMOverlayPageObject.viewport.segmentationHydration.yes.click();
  // Wait for the segmentation to hydrate.
  await page.waitForTimeout(5000);

  // navigate to the 12th image and ensure the correct overlay is displayed
  await press({ page, key: 'ArrowDown', nTimes: 11 });

  await checkForScreenshot(page, page, screenShotPaths.labelMapSegLocking.globalUnlockedSegPreEdit);

  // Attempt to erase the segmentations.
  await rightPanelPageObject.labelMapSegmentationPanel.tools.eraser.click();

  // Use the largest eraser radius to help ensure the eraser passes over the entire image.
  await rightPanelPageObject.labelMapSegmentationPanel.tools.eraser.setRadius(1000);

  // Attempt to erase the segmentations by dragging the eraser tool across the image several times.
  const defaultViewport = await viewportPageObject.getById('default');
  await defaultViewport.normalizedDragAt({
    start: { x: 0.01, y: 0.25 },
    end: { x: 1.0, y: 0.25 },
  });
  await defaultViewport.normalizedDragAt({
    start: { x: 0.01, y: 0.5 },
    end: { x: 1.0, y: 0.5 },
  });
  await defaultViewport.normalizedDragAt({
    start: { x: 0.01, y: 0.75 },
    end: { x: 1.0, y: 0.75 },
  });

  await checkForScreenshot(
    page,
    page,
    screenShotPaths.labelMapSegLocking.globalUnlockedSegPostEdit
  );
});

test('should lock hidden segments only while eraser is active', async ({
  page,
  DOMOverlayPageObject,
  leftPanelPageObject,
  rightPanelPageObject,
}) => {
  await page.evaluate(() => {
    window.services.customizationService.setGlobalCustomization('panelSegmentation.disableEditing', {
      $set: false,
    });
  });

  await rightPanelPageObject.labelMapSegmentationPanel.select();
  await leftPanelPageObject.loadSeriesByModality('SEG');
  await page.waitForTimeout(5000);
  await DOMOverlayPageObject.viewport.segmentationHydration.yes.click();
  await page.waitForTimeout(5000);

  // Ensure segment 1 starts unlocked so we can verify temporary lock/unlock behavior.
  await page.evaluate(() => {
    const { viewportGridService, segmentationService } = window.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
    segmentationService.setSegmentLocked(activeSegmentation.segmentationId, 1, false);
  });

  await rightPanelPageObject.labelMapSegmentationPanel.panel.nthSegment(0).toggleVisibility();
  await rightPanelPageObject.labelMapSegmentationPanel.tools.eraser.click();

  const isHiddenSegmentLockedOnEraser = await page.evaluate(() => {
    const { viewportGridService, segmentationService } = window.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
    return Boolean(segmentationService.getSegmentation(activeSegmentation.segmentationId)?.segments?.[1]?.locked);
  });
  expect(isHiddenSegmentLockedOnEraser).toBe(true);

  await rightPanelPageObject.labelMapSegmentationPanel.tools.brush.click();

  const isHiddenSegmentRestoredAfterSwitch = await page.evaluate(() => {
    const { viewportGridService, segmentationService } = window.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
    return Boolean(segmentationService.getSegmentation(activeSegmentation.segmentationId)?.segments?.[1]?.locked);
  });
  expect(isHiddenSegmentRestoredAfterSwitch).toBe(false);
});

test('should lock segment immediately when hidden during active eraser', async ({
  page,
  DOMOverlayPageObject,
  leftPanelPageObject,
  rightPanelPageObject,
}) => {
  await page.evaluate(() => {
    window.services.customizationService.setGlobalCustomization('panelSegmentation.disableEditing', {
      $set: false,
    });
  });

  await rightPanelPageObject.labelMapSegmentationPanel.select();
  await leftPanelPageObject.loadSeriesByModality('SEG');
  await page.waitForTimeout(5000);
  await DOMOverlayPageObject.viewport.segmentationHydration.yes.click();
  await page.waitForTimeout(5000);

  await page.evaluate(() => {
    const { viewportGridService, segmentationService } = window.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
    segmentationService.setSegmentLocked(activeSegmentation.segmentationId, 1, false);
  });

  await rightPanelPageObject.labelMapSegmentationPanel.tools.eraser.click();
  await rightPanelPageObject.labelMapSegmentationPanel.panel.nthSegment(0).toggleVisibility();

  const isHiddenSegmentLocked = await page.evaluate(() => {
    const { viewportGridService, segmentationService } = window.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
    return Boolean(segmentationService.getSegmentation(activeSegmentation.segmentationId)?.segments?.[1]?.locked);
  });
  expect(isHiddenSegmentLocked).toBe(true);
});
