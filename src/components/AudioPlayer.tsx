import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, Loader2, Music, FastForward, Rewind, MoreVertical, Download, Gauge, Smartphone } from 'lucide-react';
import { getAccessToken, googleSignIn, getRefreshToken, updateAccessToken, refreshAccessTokenServer } from '../lib/auth';
import { extractFileIdFromUrl } from '../lib/drive';

interface AudioPlayerProps {
  key?: React.Key;
  src: string;
  name: string;
  size?: string;
  isDarkMode?: boolean;
}

export default function AudioPlayer({ src, name, size, isDarkMode = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const volumeTimeoutRef = useRef<any>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [hasError, setHasError] = useState(false);
  const [isTokenExpired, setIsTokenExpired] = useState(false);

  // New features states
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);

  const startVolumeSliderTimeout = () => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }
    volumeTimeoutRef.current = setTimeout(() => {
      setShowVolumeSlider(false);
    }, 1000); // Auto-hide after 1 second of inactivity
  };

  // Stop playing when component unmounts
  useEffect(() => {
    return () => {
      if (audioUrl && audioUrl.startsWith('blob:')) {
        URL.revokeObjectURL(audioUrl);
      }
      if (volumeTimeoutRef.current) {
        clearTimeout(volumeTimeoutRef.current);
      }
    };
  }, [audioUrl]);

  // Keep playback rate in sync with audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioUrl]);

  // Handle click outside to close the options menu and volume slider
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(event.target as Node)) {
        setShowOptionsMenu(false);
        setShowSpeedMenu(false);
        setShowVolumeSlider(false);
      }
    };
    if (showOptionsMenu || showVolumeSlider) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showOptionsMenu, showVolumeSlider]);

  // Handle global play/pause sync (only one audio playing at a time)
  useEffect(() => {
    const handleGlobalPlay = (e: Event) => {
      const activeAudio = (e as CustomEvent).detail?.audioRef;
      if (activeAudio && activeAudio !== audioRef.current) {
        audioRef.current?.pause();
        setIsPlaying(false);
      }
    };

    window.addEventListener('audio_playing', handleGlobalPlay);
    return () => {
      window.removeEventListener('audio_playing', handleGlobalPlay);
    };
  }, []);

  const prepareAudioSource = async (): Promise<string> => {
    // If already prepared, return it
    if (audioUrl) return audioUrl;

    // Local base64 or blob can be played directly
    if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('file:')) {
      setAudioUrl(src);
      return src;
    }

    const isDriveUrl = src.includes('drive.google.com') || src.includes('googleusercontent.com') || extractFileIdFromUrl(src) !== null;
    
    if (!isDriveUrl) {
      setAudioUrl(src);
      return src;
    }

    // For Google Drive URLs, we stream via proxy directly to allow range-requests
    setIsLoading(true);
    setHasError(false);

    try {
      const activeToken = getAccessToken();
      const refreshToken = getRefreshToken();

      const isNetlify = window.location.hostname.includes('netlify');
      const isStaticHost = 
        !isNetlify && (
          window.location.hostname.includes('github') || 
          window.location.hostname.includes('vercel') ||
          (window.location.hostname.includes('localhost') === false && !window.location.hostname.includes('run.app'))
        );

      const backendBaseUrl = isStaticHost ? 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app' : '';
      let proxyUrl = `${backendBaseUrl}/api/download?url=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`;
      
      if (activeToken && activeToken !== 'local-dummy-token') {
        proxyUrl += `&access_token=${encodeURIComponent(activeToken)}`;
      }
      if (refreshToken) {
        proxyUrl += `&refresh_token=${encodeURIComponent(refreshToken)}`;
      }

      console.log('[AudioPlayer] Pre-flight 1-byte check via proxy:', proxyUrl);
      const response = await fetch(proxyUrl, { headers: { 'Range': 'bytes=0-0' } });
      
      const newTokenHeader = response.headers.get('x-new-access-token');
      if (newTokenHeader) {
        updateAccessToken(newTokenHeader);
      }

      if (!response.ok) {
        if (response.status === 401) {
          const refreshedToken = await refreshAccessTokenServer();
          if (refreshedToken) {
            let retryUrl = `${backendBaseUrl}/api/download?url=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}&access_token=${encodeURIComponent(refreshedToken)}`;
            if (refreshToken) retryUrl += `&refresh_token=${encodeURIComponent(refreshToken)}`;
            const retryRes = await fetch(retryUrl, { headers: { 'Range': 'bytes=0-0' } });
            if (retryRes.ok) {
              setAudioUrl(retryUrl);
              setIsLoading(false);
              setIsTokenExpired(false);
              return retryUrl;
            }
          }
          setIsTokenExpired(true);
        }
        throw new Error(`Proxy pre-flight failed: ${response.status}`);
      }

      setAudioUrl(proxyUrl);
      setIsLoading(false);
      return proxyUrl;
    } catch (err) {
      console.error('[AudioPlayer] Error checking audio source:', err);
      setHasError(true);
      setIsLoading(false);
      throw err;
    }
  };

  const handleRenewToken = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setIsLoading(true);
      const res = await googleSignIn();
      if (res?.accessToken) {
        setIsTokenExpired(false);
        setHasError(false);
        const freshUrl = await prepareAudioSource();
        if (audioRef.current) {
          audioRef.current.src = freshUrl;
          audioRef.current.load();
          audioRef.current.play()
            .then(() => {
              setIsPlaying(true);
              window.dispatchEvent(new CustomEvent('audio_playing', { detail: { audioRef: audioRef.current } }));
            })
            .catch(playErr => console.error('Play failed after token refresh:', playErr));
        }
      }
    } catch (err) {
      console.error('[AudioPlayer] Failed to renew Google Drive token:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const togglePlay = async () => {
    if (isLoading) return;

    try {
      if (!isPlaying) {
        setIsBuffering(true);
        // Prepare source if needed
        const urlToPlay = await prepareAudioSource();
        
        // Let the state update first or ensure audio is loaded
        setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.play()
              .then(() => {
                setIsPlaying(true);
                // Dispatch event to pause other players
                window.dispatchEvent(new CustomEvent('audio_playing', { detail: { audioRef: audioRef.current } }));
              })
              .catch(err => {
                console.error('Play failed:', err);
                setIsPlaying(false);
                setIsBuffering(false);
              });
          }
        }, 50);
      } else {
        audioRef.current?.pause();
        setIsPlaying(false);
        setIsBuffering(false);
      }
    } catch (e) {
      console.warn('Could not play audio', e);
      setIsBuffering(false);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      if (isFinite(audioRef.current.duration) && !isNaN(audioRef.current.duration) && audioRef.current.duration > 0 && duration !== audioRef.current.duration) {
        setDuration(audioRef.current.duration);
      }
      if (isBuffering && audioRef.current.currentTime > 0 && !audioRef.current.paused) {
        setIsBuffering(false);
      }
    }
  };

  const handleWaiting = () => {
    setIsBuffering(true);
  };

  const handlePlaying = () => {
    setIsBuffering(false);
    setIsPlaying(true);
  };

  const handleCanPlay = () => {
    if (audioRef.current && !audioRef.current.paused && audioRef.current.currentTime > 0) {
      setIsBuffering(false);
    }
  };

  const handleStalled = () => {
    if (audioRef.current && !audioRef.current.paused) {
      setIsBuffering(true);
    }
  };

  const handleDurationChange = () => {
    if (audioRef.current && isFinite(audioRef.current.duration) && !isNaN(audioRef.current.duration)) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current && isFinite(audioRef.current.duration) && !isNaN(audioRef.current.duration)) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleAudioError = () => {
    setHasError(true);
    setIsLoading(false);
    setIsBuffering(false);
    setIsPlaying(false);
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setIsBuffering(false);
    setCurrentTime(0);
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
    }
  };

  const skipForward = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (audioRef.current) {
      const current = audioRef.current.currentTime;
      const audioDuration = audioRef.current.duration || duration || 0;
      let target = current + 2;
      if (typeof audioDuration === 'number' && !isNaN(audioDuration) && isFinite(audioDuration) && audioDuration > 0) {
        target = Math.min(target, audioDuration);
      }
      audioRef.current.currentTime = target;
      setCurrentTime(target);
    }
  };

  const skipBackward = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (audioRef.current) {
      const current = audioRef.current.currentTime;
      const target = Math.max(current - 2, 0);
      audioRef.current.currentTime = target;
      setCurrentTime(target);
    }
  };

  const handleSpeedChange = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
    setShowSpeedMenu(false);
    setShowOptionsMenu(false);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (audioRef.current) {
      audioRef.current.volume = val;
      const nextMuted = val === 0;
      audioRef.current.muted = nextMuted;
      setIsMuted(nextMuted);
    }
  };

  const toggleMute = () => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }
    if (audioRef.current) {
      const nextMuted = !isMuted;
      audioRef.current.muted = nextMuted;
      setIsMuted(nextMuted);
      if (nextMuted) {
        audioRef.current.volume = 0;
      } else {
        audioRef.current.volume = volume || 1;
      }
    }
  };

  const getBackendBaseUrl = () => {
    if (typeof window === 'undefined') return '';
    const host = window.location.hostname;
    if (host.includes('run.app') || host.includes('localhost') || host === '127.0.0.1') {
      return window.location.origin;
    }
    return 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app';
  };

  const getCleanFileName = () => {
    let cleanName = name || 'audio.mp3';
    if (!/\.(mp3|wav|ogg|m4a|aac|flac|opus|wma|weba)$/i.test(cleanName)) {
      cleanName += '.mp3';
    }
    return cleanName;
  };

  const getRawStreamUrl = () => {
    if (src.startsWith('data:') || src.startsWith('blob:') || src.includes('r2.dev') || src.includes('r2.cloudflarestorage.com')) return src;
    const fileId = extractFileIdFromUrl(src);
    const baseUrl = getBackendBaseUrl();
    const fileName = getCleanFileName();

    if (fileId) {
      return `${baseUrl}/api/stream/raw/${encodeURIComponent(fileId)}/${encodeURIComponent(fileName)}`;
    }
    if (!src.includes('drive.google.com') && !src.includes('googleusercontent.com')) {
      return src;
    }
    return `${baseUrl}/api/stream/raw/${encodeURIComponent(fileName)}?url=${encodeURIComponent(src)}`;
  };

  const getAbsoluteRawStreamUrl = () => {
    const rawUrl = getRawStreamUrl();
    try {
      return new URL(rawUrl, getBackendBaseUrl() || window.location.href).href;
    } catch {
      return rawUrl;
    }
  };

  const playViaIntent = () => {
    setShowOptionsMenu(false);
    setShowSpeedMenu(false);
    const isAndroid = /android/i.test(navigator.userAgent || '');
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    const absoluteRawUrl = getAbsoluteRawStreamUrl();
    
    if (isAndroid) {
      // Direct raw media stream intent for Android audio/media players with explicit VIEW action
      const intentUrl = `intent:${absoluteRawUrl}#Intent;action=android.intent.action.VIEW;type=audio/*;end;`;
      window.location.href = intentUrl;
    } else if (isIOS) {
      // On iOS devices, try VLC URL scheme first, fallback to new tab
      const vlcUrl = `vlc://${absoluteRawUrl}`;
      window.location.href = vlcUrl;
      setTimeout(() => {
        window.open(absoluteRawUrl, '_blank');
      }, 1200);
    } else {
      // On PC / Desktop, open stream URL in new tab
      window.open(absoluteRawUrl, '_blank');
    }
  };

  const getDirectDownloadUrl = () => {
    if (src.startsWith('data:') || src.startsWith('blob:')) return src;

    const fileId = extractFileIdFromUrl(src);
    const activeToken = getAccessToken();
    const isNetlify = window.location.hostname.includes('netlify');
    const isStaticHost = 
      !isNetlify && (
        window.location.hostname.includes('github') || 
        window.location.hostname.includes('vercel') ||
        (window.location.hostname.includes('localhost') === false && !window.location.hostname.includes('run.app'))
      );

    const backendBaseUrl = isStaticHost ? 'https://ais-pre-73b5ktfwj7jc3r2bxn3pj5-351201511869.europe-west3.run.app' : '';
    let proxyUrl = `${backendBaseUrl}/api/download?url=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`;
    if (activeToken && activeToken !== 'local-dummy-token') {
      proxyUrl += `&access_token=${encodeURIComponent(activeToken)}`;
    }
    return proxyUrl;
  };

  const handleDownload = async () => {
    setShowOptionsMenu(false);
    try {
      let urlToDownload = audioUrl;
      if (!urlToDownload) {
        urlToDownload = await prepareAudioSource();
      }
      
      const link = document.createElement('a');
      link.href = urlToDownload;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Download failed:', err);
      window.open(getDirectDownloadUrl(), '_blank');
    }
  };

  const formatTime = (time: number) => {
    if (!time || isNaN(time) || !isFinite(time) || time < 0) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  const progressPercentage = isFinite(duration) && duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div 
      className={`p-3 rounded-2xl border flex flex-col gap-2 shadow-sm transition-all relative overflow-visible ${
        isDarkMode 
          ? 'bg-[#151c27] border-[#2C374E] text-[#e4edf7]' 
          : 'bg-[#fffaf5] border-[#f0ebe3] text-[#4A4A35]'
      }`}
      dir="rtl"
    >
      {/* Invisible Audio Element */}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={handleTimeUpdate}
          onDurationChange={handleDurationChange}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleAudioEnded}
          onWaiting={handleWaiting}
          onPlaying={handlePlaying}
          onCanPlay={handleCanPlay}
          onStalled={handleStalled}
          onError={handleAudioError}
        />
      )}

      {/* Top Bar: File details */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`p-1.5 rounded-lg flex items-center justify-center ${isDarkMode ? 'bg-[#1d2737]' : 'bg-[#f5ece0]'}`}>
            <Music size={16} className={isDarkMode ? 'text-[#16af75]' : 'text-[#c26700]'} />
          </span>
          <div className="min-w-0 flex-1 text-right">
            <p className="text-[11px] font-black truncate leading-tight" title={name}>
              {name}
            </p>
            {size && (
              <span className={`text-[8px] font-mono font-bold ${isDarkMode ? 'text-gray-400' : 'text-natural-muted'}`}>
                {size}
              </span>
            )}
          </div>
        </div>

        {/* Error notification or Session Renewal */}
        {isTokenExpired ? (
          <div className="flex items-center gap-1 text-[8px] sm:text-[9px] text-amber-600 dark:text-[#fcd34d] font-bold bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 rounded-md shrink-0 border border-amber-200/30">
            <span>انتهت الجلسة ⚠️</span>
            <button
              onClick={handleRenewToken}
              className="px-1.5 py-0.5 bg-amber-600 dark:bg-amber-500 hover:bg-amber-700 dark:hover:bg-amber-600 text-white font-black rounded text-[8px] transition-all cursor-pointer"
            >
              تجديد
            </button>
          </div>
        ) : hasError && (
          <span className="text-[9px] text-red-500 font-bold bg-red-100 dark:bg-red-950/40 px-1.5 py-0.5 rounded-md shrink-0">
            خطأ بالتحميل
          </span>
        )}
      </div>

      {/* Restructured Player Layout: Seek Bar Full Width + Buttons Row */}
      <div className="flex flex-col gap-2 mt-2 w-full relative">
        
        {/* Row 1: Progress Slider (Seek bar) - عداد الصوت اليساري واليميني */}
        <div className="w-full flex flex-row items-center gap-2" dir="ltr">
          <span className="text-[12px] sm:text-[12px] font-mono font-bold text-[#B4C6D8] select-none shrink-0">
            {formatTime(currentTime)}
          </span>
          <div className="relative group flex-1 flex items-center">
            <input
              type="range"
              min={0}
              max={isFinite(duration) && duration > 0 ? duration : 100}
              value={currentTime}
              onChange={handleSeekChange}
              disabled={isLoading || !audioUrl}
              className={`w-full h-1.5 rounded-lg appearance-none cursor-pointer focus:outline-none transition-all disabled:opacity-50 ${
                isDarkMode ? 'bg-gray-800' : 'bg-gray-200'
              }`}
              style={{
                background: `linear-gradient(to right, ${
                  isDarkMode ? '#16af75' : '#c26700'
                } ${progressPercentage}%, ${isDarkMode ? '#1e293b' : '#e2e8f0'} ${progressPercentage}%)`
              }}
            />
          </div>
          <span className="text-[12px] sm:text-[12px] font-mono font-bold text-[#B4C6D8] select-none shrink-0">
            {formatTime(duration)}
          </span>
        </div>

        {/* Row 2: Control Buttons and Tools - زر خيارات اضافية */}
        <div className="flex flex-row items-center justify-between w-full relative" ref={optionsMenuRef}>
          
          {/* Right side: Volume & Additional Actions Group (RTL start) */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0 relative">
            {/* Three-dots menu for extra settings */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowOptionsMenu(!showOptionsMenu);
                  setShowSpeedMenu(false);
                }}
                className="p-1 rounded-lg transition-colors hover:bg-neutral-500/10 active:scale-95 cursor-pointer text-[#B4C6D8] shrink-0"
                title="خيارات إضافية"
              >
                <MoreVertical size={14} />
              </button>

              {/* Options Dropdown Menu Popup - Fully Opaque with High Z-Index */}
              {showOptionsMenu && (
                <div 
                  style={{ backgroundColor: isDarkMode ? '#1c2635' : '#ffffff' }}
                  className={`absolute bottom-full right-0 mb-2 w-48 rounded-xl shadow-xl border p-1 z-[99] opacity-100 animate-in fade-in slide-in-from-bottom-2 duration-150 ${
                    isDarkMode 
                      ? 'border-[#2C374E] text-slate-100' 
                      : 'border-[#f0ebe3] text-[#4A4A35]'
                  }`}
                >
                  {/* Option: Play via Mobile App */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      playViaIntent();
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-[10px] sm:text-xs rounded-lg transition-colors text-right cursor-pointer bg-transparent ${
                      isDarkMode 
                        ? 'hover:bg-slate-800 text-slate-100' 
                        : 'hover:bg-neutral-100 text-[#4A4A35]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Smartphone size={13} className="opacity-80 text-amber-500 shrink-0" />
                      <span>تشغيل عبر تطبيق الجوال</span>
                    </div>
                  </button>

                  {/* Option: Playback Speed */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowSpeedMenu(!showSpeedMenu);
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-[10px] sm:text-xs rounded-lg transition-colors text-right cursor-pointer border-t bg-transparent ${
                      isDarkMode 
                        ? 'hover:bg-slate-800 border-slate-800 text-slate-100' 
                        : 'hover:bg-neutral-100 border-neutral-100 text-[#4A4A35]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Gauge size={13} className="opacity-70 shrink-0" />
                      <span>سرعة التشغيل</span>
                    </div>
                    <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                      isDarkMode ? 'bg-slate-700/60 text-slate-100' : 'bg-neutral-200/55 text-neutral-800'
                    }`}>
                      {playbackRate}x
                    </span>
                  </button>

                  {/* Speed Submenu */}
                  {showSpeedMenu && (
                    <div className={`mt-1 border-t pt-1 flex flex-col gap-0.5 max-h-32 overflow-y-auto bg-transparent ${
                      isDarkMode ? 'border-slate-800' : 'border-neutral-100'
                    }`}>
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <button
                          key={rate}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSpeedChange(rate);
                          }}
                          className={`w-full text-right px-6 py-1 text-[10px] rounded-md transition-colors cursor-pointer flex justify-between items-center bg-transparent ${
                            playbackRate === rate 
                              ? (isDarkMode ? 'bg-[#16af75]/20 text-[#16af75] font-bold' : 'bg-[#c26700]/10 text-[#c26700] font-bold')
                              : (isDarkMode ? 'hover:bg-slate-800 text-slate-100' : 'hover:bg-neutral-100 text-[#4A4A35]')
                          }`}
                        >
                          <span>{rate === 1 ? 'طبيعية (1x)' : `${rate}x`}</span>
                          {playbackRate === rate && <span className="text-[9px]">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Option: Download File */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload();
                    }}
                    className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] sm:text-xs rounded-lg transition-colors text-right cursor-pointer border-t bg-transparent ${
                      isDarkMode 
                        ? 'hover:bg-slate-800 border-slate-800 text-slate-100' 
                        : 'hover:bg-neutral-100 border-neutral-100 text-[#4A4A35]'
                    }`}
                  >
                    <Download size={13} className="opacity-70 shrink-0" />
                    <span>تنزيل الملف</span>
                  </button>
                </div>
              )}
            </div>

            {/* Volume control block */}
            <div className="relative flex items-center">
              {/* Volume toggle & trigger button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (volumeTimeoutRef.current) {
                    clearTimeout(volumeTimeoutRef.current);
                  }
                  setShowVolumeSlider(!showVolumeSlider);
                  setShowOptionsMenu(false);
                  setShowSpeedMenu(false);
                }}
                disabled={isLoading || !audioUrl}
                className={`p-1.5 rounded-lg transition-colors hover:bg-neutral-500/10 active:scale-95 cursor-pointer shrink-0 ${
                  showVolumeSlider 
                    ? (isDarkMode ? 'bg-slate-800 text-[#B4C6D8]' : 'bg-[#f5ece0] text-[#c26700]')
                    : 'text-[#B4C6D8] hover:text-gray-700 dark:hover:text-gray-300'
                }`}
                title="مستوى الصوت"
              >
                {isMuted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>

              {/* Premium Volume Slider Popover */}
              {showVolumeSlider && (
                <div
                  style={{ backgroundColor: isDarkMode ? '#1c2635' : '#ffffff' }}
                  className={`absolute bottom-full right-0 mb-2 p-2 rounded-xl shadow-xl border flex items-center gap-2 z-[99] animate-in fade-in slide-in-from-bottom-2 duration-150 ${
                    isDarkMode 
                      ? 'border-[#2C374E] text-slate-100' 
                      : 'border-[#f0ebe3] text-[#4A4A35]'
                  }`}
                >
                  {/* Clickable Icon inside Popover to quickly Mute/Unmute */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMute();
                      startVolumeSliderTimeout();
                    }}
                    className="p-1 rounded-lg hover:bg-neutral-500/10 transition-colors cursor-pointer text-gray-500 shrink-0"
                    title={isMuted ? "إلغاء كتم الصوت" : "كتم الصوت"}
                  >
                    {isMuted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  </button>

                  {/* Slider input */}
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    onMouseUp={startVolumeSliderTimeout}
                    onTouchEnd={startVolumeSliderTimeout}
                    className={`w-20 sm:w-24 h-1.5 rounded-lg appearance-none cursor-pointer focus:outline-none transition-all ${
                      isDarkMode ? 'bg-gray-800' : 'bg-gray-200'
                    }`}
                    style={{
                      background: `linear-gradient(to right, ${
                        isDarkMode ? '#16af75' : '#c26700'
                      } ${(isMuted ? 0 : volume) * 100}%, ${isDarkMode ? '#1e293b' : '#e2e8f0'} ${(isMuted ? 0 : volume) * 100}%)`
                    }}
                    dir="ltr"
                  />

                  {/* Percentage read-out */}
                  <span className="text-[9px] font-mono font-bold text-gray-400 select-none min-w-[24px] text-center">
                    {isMuted ? '0%' : `${Math.round(volume * 100)}%`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Left side: Buttons (Rewind, Play/Pause, FastForward) - (RTL end) */}
          <div className="flex items-center gap-2 sm:gap-2 shrink-0 justify-center">
            {/* Fast Forward (formerly Rewind position) */}
            <button
              onClick={skipForward}
              disabled={isLoading || !audioUrl}
              className="p-1.5 sm:p-2 rounded-full transition-colors active:scale-90 cursor-pointer text-[#B4C6D8] hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-40"
              title="تقديم ثانيتين"
            >
              <FastForward size={15} />
            </button>

            {/* Play/Pause */}
            <button
              onClick={togglePlay}
              disabled={isLoading}
              className={`h-8 w-8 sm:h-9 sm:w-9 rounded-full flex items-center justify-center shrink-0 shadow-md transition-all active:scale-90 hover:scale-105 cursor-pointer disabled:opacity-50 ${
                isDarkMode 
                  ? 'bg-[#16af75] text-white hover:bg-[#129462]' 
                  : 'bg-[#c26700] text-white hover:bg-[#a65600]'
              }`}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {(isLoading || isBuffering) ? (
                <Loader2 size={14} className="animate-spin" />
              ) : isPlaying ? (
                <Pause size={14} fill="currentColor" />
              ) : (
                <Play size={14} className="translate-x-[-0.5px]" fill="currentColor" />
              )}
            </button>

            {/* Rewind (formerly Fast Forward position) */}
            <button
              onClick={skipBackward}
              disabled={isLoading || !audioUrl}
              className="p-1.5 sm:p-2 rounded-full transition-colors active:scale-90 cursor-pointer text-[#B4C6D8] hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-40"
              title="إرجاع ثانيتين"
            >
              <Rewind size={15} />
            </button>
          </div>

        </div>
      </div>

      {/* Styled timeline slider scrollbar for standard browsers */}
      <style>{`
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: currentColor;
          cursor: pointer;
        }
        input[type="range"]::-moz-range-thumb {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: currentColor;
          cursor: pointer;
          border: none;
        }
      `}</style>
    </div>
  );
}
