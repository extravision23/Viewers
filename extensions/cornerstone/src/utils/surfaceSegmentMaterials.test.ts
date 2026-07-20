import { inferSurfaceMaterialType } from './surfaceSegmentMaterials';

describe('inferSurfaceMaterialType', () => {
  it('maps production snake_case brain labels', () => {
    const brainLabels = [
      'brainstem',
      'septum_pellucidum',
      'cerebellum',
      'caudate_nucleus',
      'lentiform_nucleus',
      'insular_cortex',
      'internal_capsule',
      'central_sulcus',
      'frontal_lobe',
      'parietal_lobe',
      'occipital_lobe',
      'temporal_lobe',
      'thalamus',
    ];
    brainLabels.forEach(label => {
      expect(inferSurfaceMaterialType({ label })).toBe('brain');
    });
  });

  it('maps CSF spaces separately from parenchyma', () => {
    expect(inferSurfaceMaterialType({ label: 'ventricle' })).toBe('csf');
    expect(inferSurfaceMaterialType({ label: 'subarachnoid_space' })).toBe('csf');
    expect(inferSurfaceMaterialType({ label: 'CSF' })).toBe('csf');
  });

  it('maps venous_sinuses to vessel', () => {
    expect(inferSurfaceMaterialType({ label: 'venous_sinuses' })).toBe('vessel');
  });

  it('maps spaced labels via normalize', () => {
    expect(inferSurfaceMaterialType({ label: 'Frontal Lobe' })).toBe('brain');
    expect(inferSurfaceMaterialType({ label: 'Left Cerebral Cortex' })).toBe('brain');
  });

  it('detects bone labels', () => {
    expect(inferSurfaceMaterialType({ label: 'Skull' })).toBe('bone');
    expect(inferSurfaceMaterialType({ cachedStats: { type: 'Bone' } })).toBe('bone');
  });

  it('detects vessel labels', () => {
    expect(inferSurfaceMaterialType({ label: 'Aorta' })).toBe('vessel');
    expect(inferSurfaceMaterialType({ label: 'CTA vessels' })).toBe('vessel');
  });

  it('falls back to default for unknowns and Class_N', () => {
    expect(inferSurfaceMaterialType({ label: 'Tumor' })).toBe('default');
    expect(inferSurfaceMaterialType({ label: 'Class_17' })).toBe('default');
    expect(inferSurfaceMaterialType({ label: 'Class_18' })).toBe('default');
    expect(inferSurfaceMaterialType(undefined)).toBe('default');
  });
});
