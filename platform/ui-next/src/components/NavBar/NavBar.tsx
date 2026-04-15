import React from 'react';
import PropTypes from 'prop-types';
import classnames from 'classnames';

const stickyClasses = 'sticky top-0';
const notStickyClasses = 'relative';

const NavBar = ({
  className,
  children,
  isSticky,
}: {
  className?: string;
  children?: React.ReactNode;
  isSticky?: boolean;
}) => {
  return (
    <div
      className={classnames(
        /* ExtraVision: green top bar (develop); popover token stays dark for menus */
        'z-20 border-background bg-[#54D414] px-1 text-white',
        /* Non-active header buttons: white; hover dim. Active tool: cyan highlight (must not use black/20 hover). */
        '[&_button:not([data-tool-active="true"])]:!text-white/90 [&_button:not([data-tool-active="true"]):hover]:!bg-black/20',
        '[&_button[data-tool-active="true"]]:!bg-highlight [&_button[data-tool-active="true"]]:!text-white [&_button[data-tool-active="true"]:hover]:!bg-highlight/80',
        isSticky && stickyClasses,
        !isSticky && notStickyClasses,
        className
      )}
    >
      {children}
    </div>
  );
};

NavBar.propTypes = {
  className: PropTypes.string,
  children: PropTypes.node,
  isSticky: PropTypes.bool,
};

export default NavBar;
