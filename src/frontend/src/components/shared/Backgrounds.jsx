import './Background.css';

export default function Background({ src }) {
  return (
    <div
      className="app-background"
      style={{ backgroundImage: `url(${src})` }}
    />
  );
}
