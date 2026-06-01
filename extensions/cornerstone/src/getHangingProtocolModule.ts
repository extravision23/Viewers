import { fourUp } from './hps/fourUp';
import { main3D } from './hps/main3D';
import { mpr } from './hps/mpr';
import { mprAnd3DVolumeViewport } from './hps/mprAnd3DVolumeViewport';
import { only3D } from './hps/only3D';
import { only3DAndSegment } from './hps/only3DAndSegment';
import { primary3D } from './hps/primary3D';
import { primaryAxial } from './hps/primaryAxial';
import { frameView } from './hps/frameView';
import { segment3D } from './hps/segment3D';

function getHangingProtocolModule() {
  return [
    {
      name: mpr.id,
      protocol: mpr,
    },
    {
      name: mprAnd3DVolumeViewport.id,
      protocol: mprAnd3DVolumeViewport,
    },
    {
      name: fourUp.id,
      protocol: fourUp,
    },
    {
      name: main3D.id,
      protocol: main3D,
    },
    {
      name: primaryAxial.id,
      protocol: primaryAxial,
    },
    {
      name: only3D.id,
      protocol: only3D,
    },
    {
      name: only3DAndSegment.id,
      protocol: only3DAndSegment,
    },
    {
      name: primary3D.id,
      protocol: primary3D,
    },
    {
      name: frameView.id,
      protocol: frameView,
    },
    {
      name: segment3D.id,
      protocol: segment3D,
    },
  ];
}

export default getHangingProtocolModule;
