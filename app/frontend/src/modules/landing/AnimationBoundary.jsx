import React from 'react';

/**
 * Isolates a decorative animation. If the player or its data ever fails to
 * load or render, this catches it and shows a static fallback instead of
 * taking the surrounding form down with it. The form lives outside this
 * boundary, so it is never affected.
 */
export default class AnimationBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.warn('[anim] decorative animation failed — falling back to static panel.', error);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
