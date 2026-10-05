import React from 'react';
import Lottie from 'lottie-react';
import AnimationBoundary from './AnimationBoundary.jsx';

/**
 * Decorative Lottie animation that fills its container. Purely visual, so it is
 * marked aria-hidden and isolated behind an error boundary: if the animation
 * data is malformed the panel quietly degrades to the static `fallbackClassName`
 * gradient and the surrounding form keeps working.
 *
 * `fit`: 'contain' shows the whole illustration centered (default — best for
 * the people/illustration art here); 'cover' fills and crops.
 */
export default function LottiePanel({
  data,
  className = '',
  fallbackClassName = '',
  fit = 'contain',
}) {
  const preserveAspectRatio = fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
  return (
    <AnimationBoundary fallback={<div className={fallbackClassName} aria-hidden />}>
      <Lottie
        animationData={data}
        loop
        autoplay
        className={className}
        rendererSettings={{ preserveAspectRatio }}
        aria-hidden
      />
    </AnimationBoundary>
  );
}
