import React from 'react';
import ChatPanel from './components/ChatPanel';

function getPanelModule({ commandsManager, extensionManager, servicesManager }) {
  return [
    {
      name: 'aiChat',
      iconName: 'tab-patient-info', // registered icon — study/patient-level assistant
      iconLabel: 'AI Assistant',
      label: 'AI Assistant',
      component: props => (
        <ChatPanel
          {...props}
          commandsManager={commandsManager}
          extensionManager={extensionManager}
          servicesManager={servicesManager}
        />
      ),
    },
  ];
}

export default getPanelModule;
