import { expect, test, visitStudy } from './utils';

test.beforeEach(
  async ({
    page,
    rightPanelPageObject,
    leftPanelPageObject,
    DOMOverlayPageObject,
    mainToolbarPageObject,
  }) => {
    const studyInstanceUID = '1.3.6.1.4.1.14519.5.2.1.256467663913010332776401703474716742458';
    const mode = 'viewer';
    await visitStudy(page, studyInstanceUID, mode, 2000);
    await rightPanelPageObject.toggle();
    await leftPanelPageObject.loadSeriesByDescription('SEG');

    await DOMOverlayPageObject.viewport.segmentationHydration.yes.click();
    await page.waitForTimeout(5000);

    await mainToolbarPageObject.layoutSelection.threeDOnlyAndSegment.click();
    await page.waitForTimeout(5000);
  }
);

test('should list segments in side panel for 3D Only + Segment view', async ({
  rightPanelPageObject,
}) => {
  const numberOfSegments =
    await rightPanelPageObject.labelMapSegmentationPanel.panel.getSegmentCount();
  expect(
    numberOfSegments,
    'The side panel should list 13 segments for the 3D Only + Segment view.'
  ).toBe(13);
});

test('should show volume rendering controls for 3D Only + Segment view', async ({
  page,
  viewportPageObject,
}) => {
  const viewport = await viewportPageObject.getNth(0);
  await viewport.overlayMenu.windowLevel.click();

  await expect(page.getByText('Rendering Options')).toBeVisible();
});
