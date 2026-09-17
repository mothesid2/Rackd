'use client';
import { motion } from 'motion/react';
import type { ReactNode, CSSProperties } from 'react';

const OFFSET: Record<string, { x?: number; y?: number; scale?: number }> = {
  up: { y: 28 },
  down: { y: -22 },
  left: { x: 28 },
  right: { x: -28 },
  scale: { scale: 0.94 },
};


export function Reveal({
  children,
  direction = 'up',
  delay = 0,
  duration = 0.7,
  amount = 0.15,
  className,
  style,
}: {
  children: ReactNode;
  direction?: keyof typeof OFFSET;
  delay?: number;
  duration?: number;
  amount?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const offset = OFFSET[direction] ?? {};
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, x: offset.x ?? 0, y: offset.y ?? 0, scale: offset.scale ?? 1 }}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, amount }}
      transition={{ duration, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>

  );
}


export function RevealGroup({ children, className, stagger = 0.08, amount = 0.15 }: { children: ReactNode; className?: string; stagger?: number; amount?: number }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </motion.div>

  );
}

export function RevealItem({ children, className, direction = 'up' }: { children: ReactNode; className?: string; direction?: keyof typeof OFFSET }) {
  const offset = OFFSET[direction] ?? {};
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, x: offset.x ?? 0, y: offset.y ?? 0, scale: offset.scale ?? 1 },
        show: { opacity: 1, x: 0, y: 0, scale: 1, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
      }}
    >
      {children}
    </motion.div>

  );
}
