import React, { useState } from 'react';
import { Button, ButtonEnums } from '@ohif/ui';

interface Task {
  taskName: string;
  label: string;
}

interface TotalSegmentatorTaskModalProps {
  tasks: Task[];
  onRun: (taskName: string) => void;
  onClose: () => void;
}

const TotalSegmentatorTaskModal: React.FC<TotalSegmentatorTaskModalProps> = ({
  tasks,
  onRun,
  onClose,
}) => {
  const [selectedTask, setSelectedTask] = useState<string>('');

  const isRunEnabled = !!selectedTask;

  const handleRun = () => {
    if (isRunEnabled) {
      onRun(selectedTask);
    }
  };

  return (
    <div className="flex flex-col bg-black text-white p-6 min-w-[500px] max-w-[600px]">
      <div className="flex gap-8 mb-6">
        <div className="flex-1">
          <h3 className="text-lg font-medium mb-4">Select a task</h3>
          <div className="border border-secondary-light rounded p-4 max-h-[400px] overflow-y-auto">
            {tasks.length === 0 ? (
              <p className="text-secondary-light">No tasks available</p>
            ) : (
              <div className="space-y-2">
                {tasks.map(task => (
                  <label
                    key={task.taskName}
                    className="flex items-start gap-3 p-2 hover:bg-secondary-dark rounded cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="task"
                      value={task.taskName}
                      checked={selectedTask === task.taskName}
                      onChange={e => setSelectedTask(e.target.value)}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium">{task.label}</div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Run Button */}
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
          onClick={handleRun}
          disabled={!isRunEnabled}
        >
          Run
        </Button>
      </div>
    </div>
  );
};

export default TotalSegmentatorTaskModal;
